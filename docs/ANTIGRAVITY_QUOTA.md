# Antigravity qua ch-relay: quota và tối ưu context

Ngày nghiên cứu: 03/11/2026 (Asia/Saigon). Phạm vi: cả Gemini và Claude trong provider Antigravity. Các kết quả dưới đây ghi nhận kiểm chứng local trước khi triển khai server.

## Kết luận có bằng chứng

Antigravity đã có tuyến bắt buộc `9router → ch-relay → Google` từ commit `3d5e5920`. Executor không fallback inference trực tiếp khi relay lỗi. Nhưng trước bản sửa này, Google transport chỉ chuyển tiếp payload; policy chỉ tối ưu `/v1/responses` và `/v1/chat/completions`.

Lỗi gây lãng phí context tìm được: `chatCore` chạy RTK sau translation, nhưng RTK chỉ biết messages/input/Kiro. Antigravity đã chuyển kết quả tool sang `request.contents[].parts[].functionResponse.response`, nên bật RTK vẫn không nén được phần này. Mỗi lượt agent tiếp tục gửi lại tool output dài trong lịch sử. Đây là một nguyên nhân ở mã nguồn; chưa có số liệu để quy toàn bộ hao quota của tài khoản cho lỗi này.

## Bản sửa

- RTK đọc được Google native/envelope, chỉ nén text output đã nhận diện; giữ cấu trúc JSON, ID, signature, ảnh, arguments và user/system text. Kiểm tra độ sâu và chu kỳ; lỗi traversal trả null, không sửa dở payload.
- Route Claude → Antigravity bảo toàn dấu lỗi tool trong payload trước khi đi qua các converter hiện có. Lỗi tool không bị RTK/context policy cắt mất.
- Policy nhận diện đúng hai endpoint Google, bỏ declaration trùng hoàn toàn và hỗ trợ cắt output dài khi có cả cấu hình lẫn header opt-in. Không hạ reasoning hoặc thay model.
- Google không nhận các trường OpenAI `prompt_cache_key`/`reasoning`. Response cache vẫn bypass; local-only không gọi relay. Kill, cancel, OAuth refresh và không fallback trực tiếp được giữ.
- Các request được kiểm tra bởi policy có giới hạn mặc định 2 MiB; vượt giới hạn vẫn chuyển nguyên payload, không tuyên bố đã tối ưu. RTK chạy trước policy và có giới hạn riêng.

## Phép đo và giới hạn

Fixture chứa một output tìm kiếm 80 dòng, cùng history và cùng cấu hình, so sánh header token saver `off` với bật RTK. Cả hai nhánh vẫn gọi relay một lần; không cache câu trả lời và không sửa số usage.

| Model fixture | Payload khi tắt RTK | Payload khi bật RTK | Giảm bytes |
|---|---:|---:|---:|
| gemini-3.8-flash-high | 6.751 | 1.918 | 71,6% |
| claude-sonnet-4-6 | 7.271 | 2.438 | 66,5% |

Đây là bytes JSON tại transport của executor, không phải tokenizer hay phép đo phần trăm quota Google. ID phiên có thể làm kết quả lặp chênh vài byte. Mẫu được chọn để kiểm tra output tool dài; tác vụ không có phần nén được có thể không giảm. Kiểm thử HTTP thật trên localhost xác nhận policy gửi output đã rút ngắn qua relay đến Google fixture, không chỉ sửa object trước khi truyền.

RTK và cắt output là biến đổi có mất thông tin. Cần đọc lại tool output đầy đủ khi thông tin bị lược cần cho tác vụ; có thể dùng `X-9Router-Token-Saver: off` để bỏ các bộ tiết kiệm cho một request.

## Vì sao không thể cam kết giống Codex

Google mô tả quota phụ thuộc lượng công việc agent và gói tài khoản. Gemini dùng pool chung theo trọng số giá API; model ngoài Gemini có giới hạn riêng. Vì vậy đổi Gemini Pro sang Flash không tạo một pool độc lập, và quota Claude không thể quy đổi trực tiếp sang Codex. Nguồn: [Antigravity plans](https://antigravity.google/docs/plans), [thay đổi quota ngày 19/05/2026](https://antigravity.google/blog/changes-to-antigravity-plans/).

OpenAI cũng ghi rõ model, context, reasoning, tool use và caching ảnh hưởng mức dùng. Không có công thức công khai cố định biến tokens thành phần trăm hạn mức thuê bao. Nguồn: [Codex/ChatGPT Work pricing](https://learn.chatgpt.com/docs/pricing).

Báo cáo local ch-relay ngày 29/10/2026 đã ghi tỷ lệ cached input Codex khoảng 93–95%, nhưng cảnh báo usage relay chưa được xác minh là hóa đơn. Các phép thử cũ thấy quota không đổi ở độ phân giải phần trăm cũng không chứng minh inference miễn quota. Đây là dữ liệu lịch sử, không phải phép đo tài khoản hiện tại. Nguồn local: `D:\wsl\ch-relay-local\quota-analysis\REPORT.md` và `D:\wsl\ch-relay-local\tests\policy\ab\REPORT.md`.

Google gateway mới không chạy adapter/padding/continuation của bundle Codex. Không có bằng chứng cho phép mang các biến đổi đó sang Google và kỳ vọng cùng hiệu quả. Backend cache Google nếu có vẫn là quyết định upstream; bản sửa không giả lập cache hit và không thêm padding để tạo số liệu đẹp.

## Áp dụng và đo tiếp

1. Bản này cần build/cập nhật 9router để có hiệu lực; không cần đổi Google gateway nếu backend đã có hai endpoint Antigravity. Chưa triển khai trong lượt nghiên cứu này.
2. Giữ RTK bật. Chọn mức thinking thấp hơn chỉ cho công việc phù hợp và model hỗ trợ; không đổi tự động yêu cầu reasoning hiện có.
3. Nếu muốn giới hạn output thêm, đặt `context.maxToolOutputChars` (ví dụ 12000) trong file policy và gửi `X-Relay-Context: truncate-tool-output`. `mode: off` chỉ tắt policy, không tắt RTK của 9router.
4. Đo A/B thật cần cùng account/model/tác vụ, cùng cache warm/cold và reasoning, không có traffic khác. Ghi quota trước/sau theo bucket/reset, số lần gọi upstream/retry, `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, `totalTokenCount`. Không cộng cached input hai lần; không suy quota từ bytes hoặc sửa usage về 0.

Lượt này không gọi inference Google thật, không refresh tài khoản thật, không đo được phần trăm quota tiết kiệm.

## Kiểm chứng bản cuối

- 342 kiểm thử riêng biệt PASS: 64 policy, 123 relay/provider/chatCore (bao gồm hai ca error-array bổ sung), 155 hồi quy RTK/thinking/signature/Antigravity. Các lượt chạy chồng lặp không cộng thêm vào tổng.
- HTTP localhost: JSON/SSE, token OAuth, lỗi 401/403/429, kill/local-only, retry, opt-in/opt-out, dry-run và output đã tối ưu đều PASS.
- Bundle Bun ch-relay thật với Google fixture: PASS JSON/SSE/401, chặn route không hợp lệ, giữ xác thực OpenAI; 3 lượt gọi upstream tổng hợp, không có inference Google thật.
- `npm run build:local`: PASS compile, 151 static pages, standalone assets. `git diff --check`: PASS.
- Log: `.scratch/antigravity-quota-relay-tests.log`, `antigravity-quota-regression.log`, `antigravity-quota-error-regression.log`, `antigravity-quota-backend.log`, `antigravity-quota-build.log`.

Sandbox Windows ban đầu chặn kết nối loopback (EACCES), thư mục temp và ghi build (EPERM). Kiểm thử dùng temp trong workspace; HTTP fixture và build được chạy lại với quyền phù hợp và đạt các kết quả trên.
