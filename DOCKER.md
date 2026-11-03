# 9router + ch-relay trên Docker

Stack chạy độc lập trên Linux amd64/arm64, không cần proxy Windows chạy nền:

```text
Client → Nginx Proxy Manager → 9router-relay:20128
                              └─ OpenAI Codex (cx) / chr → ch-relay:11500 → OpenAI
```

Cache/optimizer nằm trong 9router. Backend ch-relay chạy ở service riêng trong cùng Docker Compose. Volume riêng giữ cấu hình/tài khoản sau khi restart hoặc rebuild. Backend vẫn cần tài khoản ChatGPT hợp lệ; cài phần mềm không tự tạo tài khoản/quota.

## Chuẩn bị một lần

```sh
git clone https://github.com/tungnv107/9router-relay.git
cd 9router-relay
node scripts/init-docker-env.mjs
```

Lệnh tạo `.env` với mật khẩu dashboard (`INITIAL_PASSWORD`) và secrets ngẫu nhiên; không ghi đè file có sẵn. Không commit `.env`.

Backend là bundle local đã phục hồi của người dùng, không phải source upstream 9router. Bundle không được công khai trong Git; script đóng gói kiểm tra SHA-256 của bản đã kiểm chứng. Trên máy có thư mục gốc:

```powershell
node scripts/prepare-ch-relay.mjs 'D:\wsl\ch-relay-local'
```

Chuyển riêng thư mục `vendor/ch-relay/` vừa tạo sang cùng vị trí trong checkout server qua SSH/SCP. Chỉ asset và backend được đóng gói, không chép database, account, token hoặc key Windows. Dockerfile dùng Bun 1.4.2 để chạy source trên Linux, thay đường dẫn asset nhúng và địa chỉ lắng nghe; giữ chính sách outbound OpenAI-only của bundle. Có thể dựng lại từ thư mục local và đối chiếu `vendor/ch-relay/provenance.json`.

## Khởi động

Cần Docker Engine + Compose v2 + Buildx (Dockerfile 9router dùng BuildKit cache).

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:20128/api/health
```

Mặc định bind trên server: 9router `127.0.0.1:20128`, admin ch-relay `127.0.0.1:11504`. Inference 11500 chỉ có trong mạng Docker, không publish ra Internet. `ROUTER_PORT`, `ROUTER_BIND_IP`, `CH_RELAY_ADMIN_PORT` có thể đổi trong `.env`.

9router → Providers → **OpenAI Codex** → Add rồi đăng nhập/import tài khoản. Các connection Codex hiện có tự dùng ch-relay của Compose cho chat/Responses/compact. Tiếp tục dùng model `cx/<model-id>`; không cần tạo connection ch-relay, nhập lại token hoặc cấu hình Base URL ở UI. 9router tự lấy access token và Account ID, giữ cơ chế refresh token. Nếu relay lỗi, inference không tự bỏ qua relay.

**ch-relay Local** là tùy chọn nâng cao khi muốn dùng share key hoặc backend riêng với `chr/<model-id>`. Để Base URL trống sẽ dùng relay của server. Phép Check ở provider này chỉ đọc catalog, chưa chứng minh đăng nhập/inference thành công.

Không chuyển account Windows tự động. Có thể đăng nhập/quản lý account trong admin ch-relay qua SSH tunnel:

```sh
ssh -i /path/to/key -N -L 20128:127.0.0.1:20128 -L 11504:127.0.0.1:11504 ubuntu@161.118.222.102
```

Sau đó mở `http://localhost:20128` hoặc `http://localhost:11504` trên máy cá nhân. Admin ch-relay không public; chỉ người có quyền SSH vào server truy cập được. Đọc [CH-RELAY.md](CH-RELAY.md) để opt-in cache và hiểu giới hạn tiết kiệm quota.

Repo là snapshot từ upstream đã loại bỏ OAuth client credentials nhúng sẵn và lịch sử chứa chúng (GitHub Push Protection). Nếu dùng Gemini/Gemini CLI hoặc Antigravity OAuth, tự đặt `GOOGLE_OAUTH_CLIENT_ID/SECRET` hoặc `ANTIGRAVITY_OAUTH_CLIENT_ID/SECRET` trong `.env`. ch-relay không dùng các biến này.

### Antigravity: Google báo thiếu `client_id`

Lỗi `Missing required parameter: client_id` xảy ra khi URL đăng nhập không có OAuth client ID. Bản fork này không chứa client mặc định. Cấu hình đủ cặp client ID/secret hợp lệ dành cho Antigravity trong `.env` **trên server chạy router**, cùng thư mục với `docker-compose.yml`:

```dotenv
ANTIGRAVITY_OAUTH_CLIENT_ID=<client-id-cua-Antigravity>
ANTIGRAVITY_OAUTH_CLIENT_SECRET=<client-secret-tuong-ung>
```

Thay các giá trị mẫu bằng cấu hình thật; đây là thông tin của ứng dụng OAuth, không phải email, mật khẩu Google hay access token. Không dùng cặp client của Gemini thay cho Antigravity. Với Gemini CLI, hai tên biến đầy đủ là `GOOGLE_OAUTH_CLIENT_ID` và `GOOGLE_OAUTH_CLIENT_SECRET`.

Sau khi sửa `.env`, tạo lại riêng container router để nạp biến mới. Theo [tài liệu Docker](https://docs.docker.com/reference/cli/docker/compose/restart/), lệnh `docker compose restart` không cập nhật environment của container:

```sh
docker compose up -d --no-deps --force-recreate router
# Nếu đang dùng Nginx Proxy Manager, giữ nguyên cả hai compose file:
# docker compose -f docker-compose.yml -f compose.npm.yml up -d --no-deps --force-recreate router
```

Đây là bước nạp cấu hình vào image hiện có; thay đổi mã nguồn vẫn cần build theo mục cập nhật bên dưới. Bản sửa kiểm tra cả hai biến trước khi mở Google và trả lỗi ngay trong hộp thoại kết nối nếu thiếu cấu hình. Sau khi nạp đủ cấu hình, đóng hộp thoại cũ và chọn **Add Connection** lại để tạo URL mới. Không commit `.env` hoặc đưa secret vào URL đăng nhập.

Nếu dùng OAuth client loại **Web application**, thêm callback dưới đây vào **Authorized redirect URIs** của client trong Google Cloud, rồi đặt cùng URL trong `.env`:

```dotenv
ANTIGRAVITY_OAUTH_REDIRECT_URI=https://9router.tungnv.com/api/auth/callback/google
```

Thay domain bằng domain của router đang dùng. Đường dẫn `/api/auth/callback/google` chuyển nội bộ tới trang xử lý `/callback`; cả bước đăng nhập lẫn đổi code lấy token dùng nguyên URL đã cấu hình. Google yêu cầu URL [khớp chính xác với redirect URI đã đăng ký](https://developers.google.com/identity/protocols/oauth2/web-server#redirect-uri-validation), không chỉ domain hay JavaScript origin. Với Gemini CLI, biến tương ứng là `GOOGLE_OAUTH_REDIRECT_URI`. Bỏ trống biến redirect để giữ luồng localhost của desktop client. Việc Google chấp nhận URL đăng nhập chưa xác nhận tài khoản/client có quyền gọi API Antigravity; cần hoàn tất consent và thử model để kiểm chứng.

## Nginx Proxy Manager

Kết nối router vào mạng của NPM (server hiện tại là `npm_proxy`):

```sh
docker compose -f docker-compose.yml -f compose.npm.yml up -d --build
```

Trong NPM port 81, tạo Proxy Host:

| Trường | Giá trị |
| --- | --- |
| Domain Names | `9router.tungnv.com` |
| Scheme | `http` |
| Forward Hostname / IP | `9router-relay` |
| Forward Port | `20128` |
| Websockets Support | bật |
| Cache Assets | tắt |

DNS A trỏ `9router.tungnv.com` → `161.118.222.102`. Xin SSL Let's Encrypt trong tab SSL, bật Force SSL. Phần Advanced để SSE không bị buffer và cho phép request dài:

```nginx
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
client_max_body_size 128m;
```

Không dùng `127.0.0.1` làm Forward Host trong NPM container: đó là loopback của chính NPM. Khi HTTPS hoạt động, API Base URL là `https://9router.tungnv.com/v1`.

## Cập nhật và dữ liệu

```sh
git pull --ff-only
docker compose -f docker-compose.yml -f compose.npm.yml up -d --build
docker compose -f docker-compose.yml -f compose.npm.yml ps
```

Giữ `.env`, `vendor/ch-relay` và ba named volume. Sao lưu `.env` cùng các volume bằng quy trình backup của server; dừng service khi sao lưu SQLite để có bản nhất quán. Không dùng `docker compose down -v` nếu cần giữ tài khoản/lịch sử. Để rollback code, checkout commit cũ rồi build/up lại, không xóa volume.

9router chỉ cho phép loopback hoặc origin được operator cho phép chính xác trong `CH_RELAY_ALLOWED_ORIGINS`; UI không thể tự mở allowlist. Không dùng wildcard, credentials hay path trong allowlist. Redirect và outbound proxy bị chặn khi gửi token tới ch-relay.
