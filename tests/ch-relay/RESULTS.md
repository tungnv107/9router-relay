# Kết quả tích hợp ch-relay — 02/11/2026

## Bổ sung native Antigravity cache/thinking — 03/11/2026

- 280 kiểm thử PASS: 105 policy, 140 relay/provider/chatCore, 35 hồi quy. 9 ca E2E RTK có cờ tích hợp riêng không được bật; không tính vào số PASS.
- HTTP localhost kiểm tra Gemini và Claude native JSON/SSE: cold gọi Google fixture 1 lần, replay 0 lần, usage replay 0; phân tách caller và bảo toàn no-store/opt-out đều PASS.
- Bundle Bun ch-relay thật với profile tạm/Google fixture: PASS; JSON và SSE cold mỗi loại 1 call, replay mỗi loại 0 call. Tổng 5 call tổng hợp gồm 3 ca baseline. Không gọi tài khoản Google thật.
- Native thinkingBudget/thinkingLevel theo model: defaults/caps/opt-in, dry-run/off, bảo toàn includeThoughts/maxOutputTokens và state PASS.
- Production build PASS (151 static pages), ESLint file thay đổi và diff whitespace PASS. Bundle local đã đóng gói lại; chưa deploy/push.
- Sửa một assertion cũ kiểm tra chuỗi `2000` trên toàn SSE gây false positive khi ID ngẫu nhiên chứa chuỗi này; nay kiểm tra các trường usage bằng số.
- [Cấu hình và giới hạn](../../docs/ANTIGRAVITY_PARITY.md). Log `.scratch/antigravity-parity-*.log`; report `.scratch/antigravity-backend-report.json`.

Mã gốc: 9router `v0.5.112`, commit `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`. Môi trường kiểm chứng: Windows, Node `24.18.0`, Next.js `16.4.3` (được npm resolve từ khai báo upstream `^16.4.2`).

## Kiểm chứng bản cuối

### Codex tự dùng ch-relay — 02/11/2026, 16:19 UTC+7

- 184 kiểm thử PASS: 62 policy và 122 kiểm thử provider/HTTP/chatCore/Codex, bao gồm 23 ca mới cho transport tự động và pipeline Codex.
- `npm run build:local`: PASS, 151 static pages và standalone assets.
- `node tests/ch-relay/codex-live.mjs --ui`: PASS trên production build riêng với backend HTTP giả. Chỉ tạo một connection Codex, không có connection ch-relay hay Base URL trên account. Chat JSON, Responses SSE, compact và thông báo giao diện đều đạt.
- `node tests/ch-relay/codex-live.mjs --live`: PASS với ch-relay local thật. Hai prompt ngắn qua `cx/gpt-6-luna` và `codex/gpt-6-luna` trả HTTP 200 và marker đúng; mỗi lượt ghi nhận một request 9router → relay. Local-only bị chặn 412 với 0 request tới relay.
- Token không được in ra; profile/database kiểm thử đã xóa sau khi dừng ứng dụng. Không đổi database production, không push/deploy. Report JSON và ảnh UI nằm trong `.scratch/codex-relay-*-report.json` và `.scratch/codex-auto-relay-ui.png`.
- Kiểm chứng live xác nhận đường đi tới relay; không đo số request nội bộ relay → OpenAI hoặc mức tiết kiệm quota. OAuth refresh được kiểm tra bằng mock token rotation, không refresh tài khoản thật.

### Bổ sung Docker / Oracle ARM64 — 02/11/2026

- Docker build Node 24.18.0 + Next 16.4.3: PASS trên Ubuntu ARM64; ch-relay chạy Bun 1.4.2 với bundle local được đóng gói riêng.
- 112 test ch-relay PASS (62 policy + 50 provider/HTTP/runtime/chatCore, gồm 10 ca allowlist Docker mới).
- 60 test hồi quy usage/Responses/model routing/tool dedup và 4 test OAuth cấu hình qua môi trường PASS.
- Docker HTTP: đăng nhập dashboard, bảo vệ API, 9router gọi ch-relay qua mạng riêng đều PASS. Backend chưa có tài khoản nên trả 401 đúng dự kiến.
- JSON và SSE đi qua production container với backend fixture: mỗi cold request gọi fixture một lần; replay gọi 0 lần và usage bằng 0. Xem `docker-report.json`. Không dùng tài khoản thật cho lần kiểm chứng server này.
- UI trên server qua Edge headless: mở provider, form Add Connection và Base URL mặc định của server PASS.
- Tạo lại cả hai container: volume vẫn giữ dữ liệu, healthcheck healthy, Nginx Proxy Manager vẫn gọi được `/api/health`.
- DNS tại thời điểm kiểm tra vẫn trỏ `9router.tungnv.com` đến `74.208.236.247`; chưa cấu hình Proxy Host/SSL trong NPM. Xem [hướng dẫn Docker/NPM](../../DOCKER.md).

Các kết quả bên dưới là phép kiểm chứng Windows trước khi triển khai Docker.

| Hạng mục | Kết quả |
|---|---|
| `npm run build:local` | PASS: compile, 151 static pages, standalone assets |
| `npm run test:ch-relay` | **102/102 PASS**: 62 policy + 40 provider/HTTP/runtime/chatCore |
| Hồi quy usage/Responses/provider/tool dedup/native Codex | 7 file, 66 test PASS (gồm 2 runtime test đã tính ở hàng trên) |
| `node tests/ch-relay/live.mjs --ui` | **PASS**, 15:00:16–15:00:19 UTC+7 |
| Form thêm/sửa, catalog live | PASS qua Edge headless, xem `provider-ui.png` |
| `git diff --check` | PASS |
| ESLint file mới và pipeline backend | PASS; các lỗi UI có sẵn ghi riêng phía dưới |

Live test gọi đúng các endpoint 9router của server production build trên cổng loopback tạm. Provider kết nối qua một observer HTTP local tới proxy ch-relay thật ở `127.0.0.1:11500`. Credential ChatGPT hiện có chỉ được lưu trong database test riêng; database đã xóa sau khi dừng server. Không đổi binary/config, không deploy/push/publish hoặc đăng ký autostart.

## Kết quả HTTP thật

| Ca | HTTP | Cache tại 9router | Request từ 9router tới relay | Usage relay/client |
|---|---:|---|---:|---|
| Chat JSON lần đầu | 200 | miss | 1 | 20 input + 10 output = 30 |
| Chat JSON dùng lại, local-only | 200 | hit | **0** | **0** |
| Chat SSE lần đầu | 200 | miss | 1 | Không tổng hợp trong report |
| Chat SSE dùng lại, local-only | 200 | hit | **0** | **0**, đã kiểm tra event usage |
| Responses native stream | 200 | bypass | 1 | Không tổng hợp trong report |
| Khác scope/API key + local-only | 412 | không có entry | **0** | Không inference |
| Chọn provider khác + local-only | 412 | chặn tại 9router | **0** | Không inference |
| Discovery/test connection | 200 | không áp dụng | 0 inference | Chỉ GET models |

Cả JSON/SSE/Responses trả đúng marker tổng hợp. Replay có ID mới. Tổng lần gọi inference tới relay trong lượt đo cuối: **3**, hai replay thêm **0**. Header điều khiển và API key của 9router không được gửi nguyên văn tới relay. Danh sách 7 model live được lấy thành công; form Edit nạp đúng Base URL đã lưu.

Phép đo đếm **9router → relay**, không gắn observer vào executable ch-relay. Bản ch-relay đang chạy có cache/biến đổi riêng: những lần gửi tới relay rất nhanh có thể là hit ở lớp đó. Không được hiểu “3 request tới relay” là “3 inference mới tới OpenAI”, không lấy độ trễ ở đây làm benchmark chất lượng/chi phí. Chỉ các hit ở 9router mới được chứng minh tránh hoàn toàn request tới relay.

Usage của lượt miss là số relay trả về, chưa được đối chiếu với raw usage/hóa đơn/quota thuê bao OpenAI. Việc chuyển route qua proxy tự nó không chứng minh giảm quota. Phần tiết kiệm đã xác minh là dùng lại đáp án tĩnh đủ điều kiện mà không gửi request mới. Phiên coding chứa tools/state sẽ bypass response cache.

## Hành vi đã bảo vệ bằng test

- JSON/SSE hoàn chỉnh, TTL/LRU/giới hạn bộ nhớ; không lưu lỗi, stream hủy hoặc incomplete.
- Phân tách credential, account, client API key, connection, scope, model/body; JWT hết hạn không replay.
- Giữ usage gốc cả khi nằm trong finish chunk lẫn trailer; không cộng buffer 2.000 token, không ước lượng bù usage thiếu.
- Giữ encrypted reasoning/history/prompt cache key/tool-call ID qua chatCore; compact đi đúng `/v1/responses/compact`, không cache state.
- Chỉ gộp schema tool giống hệt; cắt output và hạ effort tường minh yêu cầu hai lớp opt-in.
- Local-only không fallback ra provider khác; kill block ngắt request đang chờ relay; policy thiếu/hỏng fail closed và nạp lại khi sửa.
- Chỉ kết nối loopback trực tiếp, không follow redirect, không ngầm bỏ qua cấu hình strict proxy.

## Giới hạn của kiểm tra toàn repository

Không tuyên bố toàn bộ suite upstream xanh. Đã chạy lại hai file lỗi trên **bản nguyên gốc xuất trực tiếp từ Git HEAD**, dùng cùng dependency, và tái hiện đúng hai vấn đề:

1. `claude-header-forwarding.test.js`: test đòi gọi `got-scraping`, nhưng nhánh đó đã bị comment trong `proxyFetch.js` upstream.
2. `cached-token-e2e.test.js`: hai assertion nghiệp vụ PASS; teardown bị EPERM trên Windows khi xóa database SQLite còn mở.

Lint hai file UI có bốn lỗi `react-hooks/set-state-in-effect`; bản upstream nguyên gốc cũng có đúng bốn lỗi ở các effect tương ứng. Không thay cấu trúc state của toàn trang để xử lý việc ngoài phạm vi tích hợp này.

Build mặc định upstream ban đầu quét vào socket Docker trong profile Windows thật và lỗi quyền. `build:local` đã giải quyết bằng profile build riêng và một worker, không sửa/xóa socket đó. Build vẫn cảnh báo bỏ qua sáu file Git pack trong thư mục temp ngoài tracing root; không mở rộng tracing root để đóng gói dữ liệu ngoài workspace. Bản production đã khởi động và chạy HTTP/UI thành công sau build.

## Thành phẩm và tái lập

- Hướng dẫn: `../../CH-RELAY.md`.
- Cấu hình mẫu: `../../ch-relay.policy.example.json`.
- Báo cáo máy đọc: `live-report.json`, `ui-report.json`.
- Ảnh form thật: `provider-ui.png`.
- SHA-256 module policy nguồn: `../../open-sse/services/chRelay/policy/provenance.json`.

Live runner chỉ dùng prompt tổng hợp; các lần sửa fixture trước lượt cuối cũng đã được dọn database/server. Không lưu token đăng nhập, API key thật hoặc nội dung dự án trong báo cáo.
