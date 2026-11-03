# ch-relay trong 9router

Tích hợp từ 9router `v0.5.112`, commit `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d` của [decolua/9router](https://github.com/decolua/9router), và bốn module policy trong `D:\wsl\ch-relay-local\policy`. Provider và cache được tích hợp vào 9router. Bản Docker chạy kèm backend ch-relay trên cùng server, độc lập với Windows; xem [DOCKER.md](DOCKER.md). Bundle backend được đóng gói riêng, không commit vào Git.

```text
Client → 9router /v1 → OpenAI Codex (cx/...) → cache/optimizer trong 9router
                                           ├─ hit: trả kết quả, không gọi relay
                                           └─ miss: http://127.0.0.1:11500/v1 → ch-relay → upstream
```

## Kết nối

1. Chạy proxy ch-relay hiện có. Inference mặc định là `http://127.0.0.1:11500/v1`; cổng admin `11504` không dùng để inference.
2. Trong 9router, mở **Providers → OpenAI Codex → Add** rồi đăng nhập/import tài khoản. Connection Codex đã có cũng tự áp dụng, không cần thêm lại.
3. Client tiếp tục gọi endpoint 9router và dùng `cx/<model>` hoặc `codex/<model>` như trước. Chat, Responses và compact tự đi qua ch-relay của server; access token và Account ID lấy từ connection được chọn. 9router tiếp tục quản lý refresh token, priority và xoay tài khoản.
4. Không cần tạo connection ch-relay riêng, sao chép token hay điền lại Base URL. Nếu relay lỗi, request báo lỗi; không tự chuyển sang gọi inference trực tiếp.

**Kết nối thủ công (tùy chọn):** **Providers → ch-relay Local → Add** chỉ dành cho share key/backend riêng. Để Base URL trống để dùng relay của server; nhập share key hoặc access token ChatGPT còn hạn, Account ID nếu cần, rồi dùng `chr/<model>` hoặc `ch-relay/<model>`. Check/Fetch Models kiểm tra kết nối `/models`, không chứng minh xác thực inference; access token nhập tay không tự refresh.

Tự định tuyến áp dụng cho chat/Responses/compact. Đăng nhập, refresh OAuth, kiểm tra tài khoản/quota và các endpoint image/STT riêng vẫn dùng luồng Codex hiện có.

## Antigravity / Google OAuth

Các connection Antigravity hiện có tự đi theo luồng `Client → 9router (ag/...) → ch-relay → Google`. Chat thường, SSE, tạo ảnh và `/v1/search` dùng endpoint riêng `/v1/antigravity/v1internal:generateContent` hoặc `/v1/antigravity/v1internal:streamGenerateContent?alt=sse` trên cùng inference port của relay. Không cần tạo connection ch-relay hay sao chép token.

Relay giữ nguyên JSON Google, project ID, tool calls, thought signatures và dữ liệu ảnh; không chuyển chúng qua Responses/Chat Completions. Access token lấy từ connection Google được 9router chọn, gửi bằng `Authorization: Bearer`. Google kiểm tra credential và quyền truy cập; lỗi 401/403 được chuyển về 9router để luồng chat refresh OAuth, lưu credential mới và thử lại qua relay. Refresh token và OAuth client secret không gửi sang relay. Đăng nhập, đổi/refresh token, discovery project và quota vẫn do 9router gọi Google như trước. Việc dùng bearer/refresh token tuân theo [tài liệu Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

Google transport chỉ cho phép hai endpoint inference trên `https://daily-cloudcode-pa.googleapis.com`; không nhận URL tùy ý, token trong query hoặc redirect, không dùng proxy môi trường. Các route OpenAI giữ guard ban đầu. `/api/network-policy` thể hiện origin cho từng provider. Nếu relay chưa được cập nhật hoặc không chạy, Antigravity báo lỗi; không gọi inference Google trực tiếp để bỏ qua relay.

Policy kill/cancel vẫn áp dụng. RTK đọc được `functionResponse.response` của Google, gồm các lớp `result/output/content/text`, nên kết quả tool dài của cả Gemini và Claude có thể được nén khi bật RTK trong 9router (mặc định bật). Các chuỗi JSON, lỗi tool, ảnh, arguments, thought signatures và prompt user/system không bị bộ nén native này cắt. Route Claude → Antigravity giữ lỗi tool trong payload để không mất dấu lỗi khi chuyển định dạng.

Policy ch-relay hỗ trợ tối ưu context Google trực tiếp: bỏ declaration trùng hoàn toàn và tùy chọn cắt chuỗi output tool với marker. Cắt output cần cả `context.maxToolOutputChars >= 256` lẫn `X-Relay-Context: truncate-tool-output`; mặc định giới hạn là 0, không cắt. `dry-run`, `off` và `X-9Router-Token-Saver: off` được tôn trọng. Các header điều khiển local không gửi tới Google. Không áp dụng `prompt_cache_key` hoặc reasoning optimizer OpenAI lên payload Google.

Exact response cache vẫn không áp dụng cho Google: `X-Relay-Cache` trả `bypass`, `X-Relay-Local-Only: 1` trả 412 và không gọi relay (payload không hợp lệ/quá giới hạn có thể trả 400/413). Usage lấy từ Google, không cộng buffer 2.000 token. Không có cam kết giảm quota chỉ nhờ đổi tuyến; xem [nghiên cứu quota và phép đo payload](docs/ANTIGRAVITY_QUOTA.md).

**Cần cập nhật đồng thời router và backend:** chạy lại `node scripts/prepare-ch-relay.mjs 'D:\wsl\ch-relay-local'`, chuyển riêng bundle `vendor/ch-relay/` mới sang server, rồi build lại cả hai service theo [DOCKER.md](DOCKER.md). Git không chứa private bundle nên chỉ cập nhật source 9router là chưa đủ. OAuth tiếp tục dùng `ANTIGRAVITY_OAUTH_CLIENT_ID/SECRET` hiện có.

Kiểm chứng local không dùng tài khoản thật:

```powershell
npm run test:ch-relay
# Cần Bun 1.4.2 trên PATH, hoặc đặt BUN_BIN tới executable Bun.
npm run test:antigravity-backend
```

Bài kiểm tra backend khởi động chính bundle Bun đã đóng gói với profile tạm, chuyển Google tới HTTP fixture local, kiểm tra JSON/SSE/401, chặn request thiếu token/route không hợp lệ và giữ xác thực OpenAI. Kết quả ghi tại `.scratch/antigravity-backend-report.json`. Bài kiểm tra này không chứng minh tài khoản Google thật có quyền sử dụng model; không sử dụng hay tiêu thụ quota của tài khoản production.

## Chat Completions / Responses của Codex

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

`X-Relay-Local-Only: 1` chỉ chấp nhận model có prefix `cx/`, `codex/`, `chr/`, `ch-relay/`, `ag/` hoặc `antigravity/`, không chấp nhận combo/alias tổng quát để tránh fallback ra provider khác. Miss trả 412; Antigravity luôn trả 412 vì không có response cache; kill=block trả 503. Không làm khóa hoặc xoay account khi bị policy chặn tại local.

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
- Antigravity: tùy chọn context trên áp dụng cho text trong `request.contents[].parts[].functionResponse.response`. Giữ nguyên generationConfig/thinkingConfig; reasoning và promptCache trong policy vẫn chỉ dành cho wire OpenAI. RTK là bộ nén riêng, bật/tắt trong settings 9router; `mode: off` của policy không tắt RTK.
- Effort: cấu hình `reasoning.models[model]` với `supported`, `defaultEffort` hoặc `maxEffort`. Giảm effort caller đã chọn cần `allowExplicitDowngrade: true` và `X-Relay-Reasoning: allow-downgrade`.
- `X-9Router-Token-Saver: off` bỏ cache/optimizer mới cho request đó, vẫn tôn trọng local-only và kill switch.
- `Cache-Control: no-store` hoặc `X-Relay-Cache: bypass` bỏ response cache. Module tích hợp không ghi audit chứa prompt/credential ra đĩa.

Quay lại policy cũ bằng cách thay file JSON đã backup. Bản fork này luôn định tuyến chat Codex qua relay; muốn khôi phục đường inference trực tiếp cần rollback mã nguồn. Không có thay đổi binary, database, cấu hình Codex hoặc autostart của proxy đang chạy.

## Kiểm chứng và chạy từ source

```powershell
Set-Location D:\Projects\9RouterRelay
npm install
npm --prefix tests install
npm run test:ch-relay
npm run build:local
npm start
```

Kiểm tra bản build với chỉ một connection Codex, gồm HTTP và giao diện:

```powershell
node tests/ch-relay/codex-live.mjs --ui
```

Để kiểm tra hai prompt ngắn qua ch-relay thật đang chạy và access token ChatGPT local hiện có, chạy `node tests/ch-relay/codex-live.mjs --live`. Script dùng profile riêng rồi xóa sau khi dừng, không sửa tài khoản production; không tự refresh token. Report ở `.scratch/codex-relay-live-report.json`.

`npm start` mặc định cổng 20127. Để dùng dữ liệu riêng cho checkout này, đặt `DATA_DIR=D:\Projects\9RouterRelay\data` trước khi start. Không dùng chung DATA_DIR với instance 9router khác đang chạy.

`build:local` tạo profile build riêng trong `.scratch/` và dùng một worker lấy page data. Cách này tránh Next.js quét nhầm socket/dữ liệu trong profile Windows thật, đồng thời tránh các build worker ghi đồng thời database. Script không sửa profile hay database của 9router đang dùng.

Live check có chủ đích tạo ba prompt tổng hợp qua relay thật (có thể tiêu thụ quota); cần phiên ChatGPT còn hạn trong `.codex/auth.json`. Không refresh token. Khởi động 9router tạm trên loopback với database riêng, đếm request relay qua observer, xóa database chứa credential và dừng server khi xong:

```powershell
node tests/ch-relay/live.mjs --ui
```

Kết quả lưu tại `tests/ch-relay/live-report.json`; screenshot form ở `tests/ch-relay/provider-ui.png`. Policy gốc và SHA-256 nguồn được ghi ở `open-sse/services/chRelay/policy/provenance.json`. Các sửa đổi so với policy nguồn: phân tách prompt-cache key theo principal 9router/prefix chat; opt-out optimizer theo header nội bộ. Chi tiết kiểm thử xem `tests/ch-relay/RESULTS.md`.

Tích hợp này không thay cơ chế padding/continuation/retry hoặc giới hạn outbound bên trong executable ch-relay đang chạy. Kiểm tra thực tế ngày 02/11/2026: `/healthz` trả 200, `/v1/models` với credential hợp lệ trả danh sách model; `/api/network-policy` trên instance hiện có trả 404. Không suy từ bản source OpenAI-only trong thư mục local rằng binary đang chạy cũng có guard đó.
