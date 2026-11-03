# Antigravity: cache và tối ưu tương đương policy Codex

Ngày: 03/11/2026 (Asia/Saigon). Thay đổi trong source và bundle local; chưa deploy/push.

## Cơ chế

| Cơ chế | Antigravity native |
|---|---|
| Exact response cache | JSON và SSE văn bản hoàn chỉnh; chỉ khi opt-in và có scope |
| Phân tách cache | Credential, caller/connection, project, session, model, URL, nội dung và cấu hình |
| Request ID | Bỏ riêng ID chứa timestamp khỏi khóa cache; vẫn gửi ID gốc khi miss |
| Replay | Không gọi relay/Google; ID mới; usage bằng 0; audit giữ usage gốc dạng số |
| TTL/LRU/giới hạn bytes | Dùng chung policy engine của Codex; mặc định TTL 5 phút |
| Context | Dedup tool schema và RTK; cắt output cần cấu hình + header |
| Thinking | Rule theo model, dùng `thinkingBudget` hoặc `thinkingLevel` native |
| Kill/dry-run/opt-out/local-only | Dùng chung policy và header điều khiển với Codex |

Cache bỏ qua tools, tool history, thought signatures, ảnh, tìm kiếm/grounding, cachedContent và trường chưa biết. Không lưu stream lỗi/bị hủy/thiếu STOP/thiếu EOF, output bị cắt, lỗi HTTP hoặc phản hồi có no-store/cookie. Payload và state gốc không bị sửa khi replay không đủ điều kiện. Hai cold miss đồng thời vẫn có thể gọi upstream hai lần.

## Bật cache cho tác vụ tĩnh

Gửi đến API 9router, giữ nguyên body và các header sau cho cùng tác vụ:

```http
X-Relay-Cache: allow
X-Relay-Cache-Scope: immutable-task-v1
X-Session-Id: immutable-task-session
```

Model dùng prefix `ag/` hoặc `antigravity/`. Lượt đầu có thể trả `miss`, lượt sau `hit`. Thêm `X-Relay-Local-Only: 1` để lượt sau chỉ được lấy cache; không có kết quả thì trả 412, không inference. `X-9Router-Token-Saver: off`, `X-Relay-Cache: bypass` hoặc `Cache-Control: no-store` bỏ cache. Cookie/idempotency-key cũng buộc bypass. Đổi scope khi dữ liệu ngoài request thay đổi.

Gateway phải là bundle mới: mặc định `Cache-Control: private, no-cache` để ngăn cache HTTP dùng chung, cho phép policy local có opt-in. `no-store` hoặc cookie từ Google vẫn chặn lưu. Không thay chỉ số usage của một request đã gọi upstream thành 0.

## Thinking native

Trong file `CH_RELAY_POLICY_FILE`, thêm model đúng tên nhận tại transport vào `reasoning.antigravityModels`. Ví dụ cho Gemini 2.5 Flash:

```json
{
  "reasoning": {
    "models": {},
    "antigravityModels": {
      "gemini-2.5-flash": {
        "field": "thinkingBudget",
        "defaultValue": 1024,
        "maxValue": 4096,
        "allowExplicitDowngrade": true
      }
    }
  }
}
```

Đây là đoạn ghép vào file policy đầy đủ, không thay toàn bộ file. `defaultValue` chỉ điền khi caller chưa chọn budget/level. Hạ budget đã chọn (gồm budget động `-1`) còn cần `X-Relay-Reasoning: allow-downgrade`. Giá trị nhỏ hơn mức trần được giữ nguyên. `maxOutputTokens`, `includeThoughts`, tool IDs, signatures và thứ tự history được giữ. Không có rule thì không đổi thinking; mặc định toàn bộ map trống.

Với model hỗ trợ level, dùng `field: "thinkingLevel"`, `supported: ["low", "high"]` (hoặc tập level thật sự được model hỗ trợ, theo thứ tự tăng dần), `defaultValue: "low"` và `maxValue: "low"`. Không suy rằng mọi Gemini/Claude đều hỗ trợ cùng level/budget. Nếu caller đang dùng loại điều khiển khác rule, policy giữ nguyên thay vì tự quy đổi. Rule theo tên model chính xác không áp cho model khác.

Google định nghĩa hai trường trong [GenerateContent / ThinkingConfig](https://ai.google.dev/api/generate-content); `thinkingLevel` không dùng cho Gemini 2.5. Tài liệu Gemini API mô tả cấu trúc native, không chứng minh quota thuê bao Antigravity giảm theo một tỷ lệ cụ thể.

## Prompt cache và giới hạn đo lường

Session/prefix native hiện có tiếp tục được giữ. Không đưa `prompt_cache_key`, padding của Codex hoặc resource `cachedContent` tự tạo vào giao thức Google. Cache prefix ở Google phụ thuộc upstream; bộ replay local là cơ chế riêng, chỉ tiết kiệm lượt inference khi có hit đủ điều kiện. Phiên coding có tool/state vẫn cần inference; RTK/context và thinking mới có thể giảm lượng công việc gửi lên.

Kiểm chứng dùng Google HTTP fixture trên localhost và chính bundle Bun ch-relay đã đóng gói, không dùng tài khoản Google thật. Cold JSON/SSE mỗi loại gọi upstream một lần; replay mỗi loại thêm **0** request và **0** usage. Đây là bằng chứng tránh inference của replay, chưa phải phép đo phần trăm quota của tác vụ thực tế.

## Áp dụng

Đóng gói lại private bundle với `node scripts/prepare-ch-relay.mjs 'D:\wsl\ch-relay-local'`, build cả router và ch-relay khi triển khai. Chỉ cập nhật router trong khi gateway cũ luôn trả no-store sẽ không tạo được cache entry. Bundle local đã được dựng lại và kiểm tra; server đang chạy chưa được thay đổi.

Kiểm tra bằng `npm run test:ch-relay`, `npm run test:antigravity-backend` và `npm run build:local`. Log lần thực hiện nằm trong `.scratch/antigravity-parity-*.log`; report backend ở `.scratch/antigravity-backend-report.json`.

Kết quả local: **280 kiểm thử đạt** (105 policy, 140 relay/provider/chatCore, 35 hồi quy), 9 ca E2E của suite RTK được bỏ qua vì chưa bật cờ tích hợp. Kiểm thử bundle Bun/HTTP đạt cả cold/replay JSON và SSE; build production đạt 151 static pages. ESLint các file thay đổi và `git diff --check` đạt. Một assertion SSE cũ tìm chuỗi `2000` trong toàn bộ response đã được sửa để kiểm tra các trường usage, tránh báo sai khi ID ngẫu nhiên chứa chuỗi này.
