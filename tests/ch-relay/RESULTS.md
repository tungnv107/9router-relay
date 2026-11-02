# Kết quả tích hợp ch-relay — 02/11/2026

Mã gốc: 9router `v0.5.112`, commit `1fe586bb1cf35e1ed0cb2150a8ef7d1db040b21d`. Môi trường kiểm chứng: Windows, Node `24.18.0`, Next.js `16.4.3` (được npm resolve từ khai báo upstream `^16.4.2`).

## Kiểm chứng bản cuối

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
