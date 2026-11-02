# ch-relay trong 9router

Tích hợp từ 9router `v0.5.112`, commit `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d` của [decolua/9router](https://github.com/decolua/9router), và bốn module policy trong `D:\wsl\ch-relay-local\policy`. Provider và cache được tích hợp vào 9router. Bản Docker chạy kèm backend ch-relay trên cùng server, độc lập với Windows; xem [DOCKER.md](DOCKER.md). Bundle backend được đóng gói riêng, không commit vào Git.

```text
Client → 9router /v1 → provider ch-relay → cache/optimizer trong 9router
                                           ├─ hit: trả kết quả, không gọi relay
                                           └─ miss: http://127.0.0.1:11500/v1 → ch-relay → upstream
```

## Kết nối

1. Chạy proxy ch-relay hiện có. Inference mặc định là `http://127.0.0.1:11500/v1`; cổng admin `11504` không dùng để inference.
2. Trong 9router, mở **Providers → ch-relay Local → Add**.
3. Nhập tên connection; Base URL mặc định ở trên; API Key là **share key của relay hoặc access token ChatGPT còn hạn**, không phải API key của 9router. Điền ChatGPT Account ID nếu tài khoản yêu cầu. Check/Fetch Models kiểm tra `/models`; inference là phép kiểm tra xác thực cuối cùng. Access token nhập tay không tự refresh; ưu tiên share key nếu instance của bạn đã có cơ chế quản lý tài khoản.
4. Client tiếp tục gọi endpoint 9router, chọn `chr/gpt-6-luna` hoặc `ch-relay/gpt-6-luna`. Trang provider tự tải danh sách model từ connection đang bật. Model seed chỉ là gợi ý khi chưa tải được catalog, không cam kết quyền truy cập tài khoản.

Provider hỗ trợ Chat Completions và Responses. Khi client dùng hai định dạng này, request giữ reasoning, encrypted state, prompt cache key, tool-call ID và history qua 9router. Client định dạng khác dùng translator sẵn có của 9router.

`/v1/responses/compact` được chuyển đúng endpoint compact của relay, không cache state và không gửi cờ nội bộ `_compact` lên upstream.

Mặc định Base URL chỉ nhận loopback HTTP(S): `127.0.0.1`, `localhost`, `[::1]`; không nhận user/password/query/fragment trong URL. `localhost` được đổi thành `127.0.0.1`. URL có thể dùng cổng khác. Không dùng proxy pool/outbound proxy cho connection này. Với Docker, Compose cho phép chính xác `http://ch-relay:11500` qua `CH_RELAY_ALLOWED_ORIGINS` và đặt `CH_RELAY_BASE_URL`. Để Base URL trong UI trống để dùng giá trị server. `localhost` luôn là máy/container của tiến trình 9router.

## Tối ưu quota

- **Exact response cache**: mặc định bật chế độ enforce nhưng cần opt-in từng request. Chỉ hit mới tránh được một lượt gọi relay/upstream. Cache trong RAM, TTL 5 phút, tối đa 128 entry/16 MiB; restart hoặc thay policy sẽ mất cache.
- **Tool schema**: bỏ bản sao JSON giống hệt; giữ tool cùng tên có schema khác, thứ tự history và output tool.
- **Prompt cache**: giữ nguyên key caller; có thể bật tạo key ổn định theo model, scope, credential/principal và prefix. Đây vẫn là request upstream; không hứa số phần trăm tiết kiệm.
- **Reasoning/context**: mặc định không hạ effort hoặc cắt nội dung. Muốn cắt output tool/giảm effort do caller chỉ định cần bật trong policy và opt-in header.

Ví dụ tác vụ text cố định cho phép dùng lại:

```powershell
$headers = @{
  Authorization = "Bearer $env:NINEROUTER_API_KEY"
  'X-Relay-Cache' = 'allow'
  'X-Relay-Cache-Scope' = 'immutable-task-v1'
}
$body = @{
  model = 'chr/gpt-6-luna'
  stream = $false
  reasoning_effort = 'low'
  messages = @(@{ role = 'user'; content = 'Trả lời đúng một số: 17 nhân 23 bằng bao nhiêu?' })
} | ConvertTo-Json -Depth 10
Invoke-WebRequest 'http://127.0.0.1:20127/v1/chat/completions' -Method Post -Headers $headers -ContentType 'application/json' -Body $body

# Lượt hai bắt buộc dùng cache, cấm gửi tới relay nếu miss:
$headers['X-Relay-Local-Only'] = '1'
Invoke-WebRequest 'http://127.0.0.1:20127/v1/chat/completions' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

Đổi scope khi dữ liệu ngoài request thay đổi. Không opt-in câu hỏi thời gian thực. Scope phải gồm 1–160 ký tự chữ/số hoặc `_ . : / -`. Cache phân tách toàn bộ relay credential, account, connection, API key của client, URL, scope và body. API key 9router được HMAC tại local và không gửi tới relay.

Header kết quả: `X-Relay-Cache: miss|hit|bypass|would-hit`, `X-Relay-Policy-Mode`, `X-Relay-Policy-Revision`. Hit thêm `X-Relay-Upstream-Requests: 0`, `X-Relay-Billable-Tokens: 0`, `X-Relay-Usage-Source: local-cache`. Miss giữ nguyên usage relay trả về; 9router không cộng buffer 2.000 token hay ước lượng bù usage cho provider này. Usage của relay chưa phải số liệu hóa đơn/percentage quota được xác minh trực tiếp từ upstream.

`X-Relay-Local-Only: 1` chỉ chấp nhận model có prefix `chr/` hoặc `ch-relay/`, không chấp nhận combo/alias tổng quát để tránh fallback ra provider khác. Miss trả 412; kill=block trả 503. Không làm khóa hoặc xoay account khi bị policy chặn tại local.

Request có tools, tool history, encrypted reasoning, ảnh/audio, previous_response_id, conversation, store=true, background hoặc trường chưa biết sẽ không cache câu trả lời. Không cache lỗi, refusal, stream bị ngắt hoặc response chưa hoàn tất. Hai cold miss đồng thời vẫn có thể gọi upstream hai lần. Các phiên coding dùng tools thường không có response-cache hit; không có cam kết miễn token hay tăng quota tài khoản.

## Cấu hình policy

Không cần cấu hình để dùng mặc định. Muốn tùy chỉnh, sao chép `ch-relay.policy.example.json` sang một file riêng và đặt biến môi trường trước khi khởi động 9router:

```powershell
$env:CH_RELAY_POLICY_FILE = 'D:\Projects\9RouterRelay\data\ch-relay-policy.json'
npm start
```

File được đọc lại trước mỗi request và mỗi 100 ms khi đang xử lý request/stream. File được chỉ định nhưng thiếu/hỏng sẽ block. Có thể sửa `mode` thành `dry-run` (chỉ khảo sát, vẫn gọi relay), `off` (không cache/tối ưu) hoặc `enforce`. Mọi thay đổi policy làm mất cache.

- Kill nóng: đặt `killSwitch: "block"` trong JSON hoặc tạo file `KILL_SWITCH` cạnh JSON với nội dung `block`. Đặt `bypass` để tạm bỏ optimizer/cache nhưng vẫn gọi relay. Biến `CH_RELAY_POLICY_KILL=block|bypass` áp dụng khi khởi động process và có ưu tiên cao hơn file. Không hủy được token upstream đã xử lý trước khi abort tới nơi.
- Prompt cache: `promptCache.enabled=true`, thêm đúng model vào `promptCache.models`; request cần scope. Không ghi đè key caller. Key tự tạo ổn định trong một process, đổi sau restart vì HMAC secret chỉ nằm trong RAM.
- Cắt tool output: `context.maxToolOutputChars` từ 256 trở lên và header `X-Relay-Context: truncate-tool-output`. Có marker rõ ràng và giữ đầu/cuối.
- Effort: cấu hình `reasoning.models[model]` với `supported`, `defaultEffort` hoặc `maxEffort`. Giảm effort caller đã chọn cần `allowExplicitDowngrade: true` và `X-Relay-Reasoning: allow-downgrade`.
- `X-9Router-Token-Saver: off` bỏ cache/optimizer mới cho request đó, vẫn tôn trọng local-only và kill switch.
- `Cache-Control: no-store` hoặc `X-Relay-Cache: bypass` bỏ response cache. Module tích hợp không ghi audit chứa prompt/credential ra đĩa.

Quay lại cấu hình cũ bằng cách thay file JSON đã backup; bỏ provider khỏi client hoặc chọn provider cũ để ngừng dùng ch-relay. Không có thay đổi binary, database, cấu hình Codex hoặc autostart của proxy đang chạy.

## Kiểm chứng và chạy từ source

```powershell
Set-Location D:\Projects\9RouterRelay
npm install
npm --prefix tests install
npm run test:ch-relay
npm run build:local
npm start
```

`npm start` mặc định cổng 20127. Để dùng dữ liệu riêng cho checkout này, đặt `DATA_DIR=D:\Projects\9RouterRelay\data` trước khi start. Không dùng chung DATA_DIR với instance 9router khác đang chạy.

`build:local` tạo profile build riêng trong `.scratch/` và dùng một worker lấy page data. Cách này tránh Next.js quét nhầm socket/dữ liệu trong profile Windows thật, đồng thời tránh các build worker ghi đồng thời database. Script không sửa profile hay database của 9router đang dùng.

Live check có chủ đích tạo ba prompt tổng hợp qua relay thật (có thể tiêu thụ quota); cần phiên ChatGPT còn hạn trong `.codex/auth.json`. Không refresh token. Khởi động 9router tạm trên loopback với database riêng, đếm request relay qua observer, xóa database chứa credential và dừng server khi xong:

```powershell
node tests/ch-relay/live.mjs --ui
```

Kết quả lưu tại `tests/ch-relay/live-report.json`; screenshot form ở `tests/ch-relay/provider-ui.png`. Policy gốc và SHA-256 nguồn được ghi ở `open-sse/services/chRelay/policy/provenance.json`. Các sửa đổi so với policy nguồn: phân tách prompt-cache key theo principal 9router/prefix chat; opt-out optimizer theo header nội bộ. Chi tiết kiểm thử xem `tests/ch-relay/RESULTS.md`.

Tích hợp này không thay cơ chế padding/continuation/retry hoặc giới hạn outbound bên trong executable ch-relay đang chạy. Kiểm tra thực tế ngày 02/11/2026: `/healthz` trả 200, `/v1/models` với credential hợp lệ trả danh sách model; `/api/network-policy` trên instance hiện có trả 404. Không suy từ bản source OpenAI-only trong thư mục local rằng binary đang chạy cũng có guard đó.
