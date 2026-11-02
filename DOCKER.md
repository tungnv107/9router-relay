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
