# MSaving

Ứng dụng theo dõi chi tiêu do bạn tự chạy, cho bạn, gia đình hoặc một nhóm nhỏ. Dữ liệu tiền bạc nằm trên máy
hoặc máy chủ của chính bạn: không ai khác vận hành nó, và dự án không thu thập gì.

*English: [README.md](README.md)*

- Nhiều sổ (cá nhân, gia đình, kinh doanh nhỏ), mỗi sổ một loại tiền
- Tài khoản bằng bất kỳ loại tiền nào: tiền mặt, ngân hàng, tiết kiệm, đầu tư, thẻ tín dụng, khoản vay, cho vay
- Chi tiêu, thu nhập, chuyển khoản, hoàn tiền, có lịch sử chỉnh sửa đầy đủ
- Danh mục, ngân sách theo ngày, tuần, tháng, quý hoặc năm, trang tổng quan
- Ai nợ ai: tiền cho vay và đi vay, theo từng người
- Sổ chia sẻ với vai trò (chủ sở hữu, người chỉnh sửa, người xem)
- Tỷ giá hằng ngày, không cần tài khoản hay khóa nào
- Tải toàn bộ dữ liệu dưới dạng tệp CSV dễ đọc; xóa tài khoản bất cứ lúc nào
- Tiếng Việt và tiếng Anh

Miễn phí và mã nguồn mở ([AGPL-3.0](LICENSE)). Tình trạng: đang chuẩn bị bản phát hành đầu tiên; ứng dụng di
động (Android, iOS) sẽ có sau.

## Cài đặt

Bạn cần một máy luôn bật (máy tính ở nhà, mini PC, Raspberry Pi 4 trở lên, hoặc VPS) có
[Docker](https://docs.docker.com/engine/install/) và Docker Compose. 1 GB bộ nhớ là đủ.

```bash
mkdir msaving && cd msaving
curl -O https://raw.githubusercontent.com/LeeMinNguyeen/msaving/main/docker-compose.yml
docker compose up -d
docker compose logs msaving
```

Nhật ký hiện một **mã thiết lập**, dạng `CJJV-SJ9H-EDWZ`. Mở http://localhost:8080, nhập mã và tạo tài khoản:
tài khoản này trở thành **quản trị viên** của máy chủ. Mã chứng minh bạn là người đã cài máy chủ, nên người lạ
tìm thấy nó trước cũng không chiếm được. Mỗi lần khởi động sẽ in mã mới cho đến khi có quản trị viên.

Không cần cấu hình gì thêm: cơ sở dữ liệu, mật khẩu của nó và các công việc hằng ngày được thiết lập ở lần khởi
động đầu tiên.

## Mời người khác

Tài khoản mới cần lời mời. Là quản trị viên, mở **Quản trị máy chủ**, rồi **Tạo lời mời**. Gửi đường dẫn, hoặc
cho họ quét mã QR: họ chọn tên người dùng và mật khẩu là xong. Mỗi lời mời dùng được một lần và có hạn (1, 7
hoặc 30 ngày). Không có email: nếu ai đó quên mật khẩu, hãy tạo **Đường dẫn đặt lại** cho họ trên cùng màn hình.

Bạn cũng có thể mở đăng ký cho bất kỳ ai truy cập được máy chủ (**Quản trị máy chủ**, **Tài khoản mới**).

## Dùng từ thiết bị khác

Máy chủ chỉ nghe trên chính máy đó (`127.0.0.1:8080`) cho đến khi bạn chọn cách cho người khác truy cập. Ứng dụng
di động sẽ cần HTTPS, nên hãy chọn một trong các cách sau:

**Tailscale (nên dùng cho máy ở nhà và nhóm riêng tư).** Mọi người trong nhóm cài
[Tailscale](https://tailscale.com/download) và vào mạng của bạn; không mở gì ra Internet. Trên máy chủ:

```bash
tailscale serve --bg 8080
```

Lệnh in ra địa chỉ dạng `https://money.your-network.ts.net`.

**Tên miền của bạn.** Trỏ một tên miền (ví dụ `money.example.com`) về máy chủ, mở cổng 80 và 443, rồi tạo tệp
`.env` cạnh `docker-compose.yml`:

```
COMPOSE_PROFILES=https
DOMAIN=money.example.com
```

Sau đó chạy `docker compose up -d`. Caddy tự lấy và gia hạn chứng chỉ.

**Cloudflare Tunnel.** Cho máy ở nhà không mở được cổng: tạo tunnel trên trang quản lý Cloudflare, trỏ tên máy
của bạn tới `http://localhost:8080`, và chạy `cloudflared` trên máy chủ
([hướng dẫn](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)).

**Chỉ trong mạng gia đình, không HTTPS.** Đặt `BIND=0.0.0.0` trong `.env` và mở
`http://<địa chỉ máy chủ>:8080`. Dữ liệu không được mã hóa trên đường truyền, nên chỉ làm vậy trong mạng bạn tin
tưởng, và ứng dụng di động sẽ không dùng được cách này.

## Cập nhật

```bash
docker compose pull
docker compose up -d
```

Máy chủ tự sao lưu trước khi thay đổi cơ sở dữ liệu. Để giữ nguyên một phiên bản, đặt `MSAVING_VERSION=1.2.0`
trong `.env`. Quản trị viên sẽ thấy trên **Quản trị máy chủ** khi có phiên bản mới.

**Cập nhật bằng một nút bấm (tùy chọn).** Thêm `COMPOSE_PROFILES=updater` vào `.env` (`https,updater` nếu dùng
Caddy) rồi chạy `docker compose up -d`. Khi đó quản trị viên có thể bấm **Cập nhật ngay** trên **Quản trị máy
chủ**. Việc này chạy một trình trợ giúp nhỏ có quyền điều khiển Docker trên máy, tương đương quyền root: nó chỉ
tải ảnh MSaving và khởi động lại container đó, nhưng chỉ bật nếu bạn chấp nhận điều này. Cập nhật là tính năng
của ứng dụng web; ứng dụng di động không làm việc này.

## Sao lưu

Mỗi đêm (và trước mỗi lần cập nhật) máy chủ ghi một bản sao lưu vào volume `backups` và giữ khoảng 6 ngày. Chúng
nằm trên cùng ổ đĩa với máy chủ, nên hãy **sao chép sang nơi khác** thường xuyên:

```bash
docker compose cp msaving:/backups ./msaving-backups
```

Bản sao lưu có chứa mã băm mật khẩu: hãy giữ kín các bản sao.

Để khôi phục một bản (thay thế toàn bộ dữ liệu trên máy chủ):

```bash
docker compose stop msaving
docker compose cp ./msaving-backups/msaving-<time>.dump db:/tmp/restore.dump
docker compose exec db dropdb -U postgres --force --maintenance-db=template1 postgres
docker compose exec db createdb -U postgres postgres
docker compose exec db psql -U postgres -c 'alter default privileges revoke execute on functions from public'
docker compose exec db sh -c "pg_restore --list /tmp/restore.dump | grep -v -E ' (SCHEMA|COMMENT) - (SCHEMA )?public ' > /tmp/restore.list && pg_restore -U postgres --no-owner --single-transaction --exit-on-error --use-list=/tmp/restore.list -d postgres /tmp/restore.dump"
docker compose start msaving
docker compose exec msaving python -m app.admin repurge
```

Dòng cuối xóa lại những tài khoản đã bị xóa vĩnh viễn sau thời điểm sao lưu.

## Khi ứng dụng web không giúp được

```bash
docker compose exec msaving python -m app.admin reset-password <tên người dùng>   # đường dẫn đặt lại dùng một lần, cả cho quản trị viên
docker compose exec msaving python -m app.admin make-admin <tên người dùng>       # quản trị viên mới
```

## Cơ sở dữ liệu của bạn

MSaving mặc định chạy PostgreSQL riêng. Để dùng cơ sở dữ liệu của bạn (PostgreSQL 15 trở lên, hoặc kết nối trực
tiếp của một dự án Supabase), đặt trong `.env`, với quyền chủ sở hữu cơ sở dữ liệu:

```
ADMIN_DATABASE_URL=postgresql://postgres:PASSWORD@HOST:5432/postgres?sslmode=require
```

và khởi động không kèm cơ sở dữ liệu có sẵn: `docker compose up -d --scale db=0`. Máy chủ tự tạo các tài khoản
đăng nhập giới hạn quyền của nó trong cơ sở dữ liệu đó.

## Cài đặt tùy chọn

Tất cả đều không bắt buộc, trong tệp `.env` cạnh `docker-compose.yml` ([ví dụ](.env.example)):

| Cài đặt | Mặc định | Tác dụng |
|---|---|---|
| `PORT` | `8080` | Cổng trên máy chủ |
| `BIND` | `127.0.0.1` | Ai truy cập được cổng đó: `127.0.0.1` chỉ máy này, `0.0.0.0` mọi mạng |
| `COMPOSE_PROFILES`, `DOMAIN` | | `https` và tên miền của bạn: HTTPS qua Caddy |
| `MSAVING_VERSION` | `latest` | Chạy phiên bản nào |
| `ADMIN_DATABASE_URL` | | Cơ sở dữ liệu của bạn thay cho cơ sở dữ liệu có sẵn |
| `OXR_APP_ID` | | Tỷ giá từ Open Exchange Rates bằng khóa của bạn, thay cho nguồn miễn phí |
| `JOBS_HOUR` | `19` | Giờ chạy công việc hằng ngày, theo giờ UTC (19 = 02:00 giờ Việt Nam) |
| `COMPOSE_PROFILES` `updater` | | Cập nhật bằng một nút bấm từ ứng dụng web (xem Cập nhật) |
| `UPDATE_CHECK` | `on` | `off`: không bao giờ hỏi GitHub có phiên bản mới không |

## Bảo mật

- Mật khẩu được lưu dưới dạng mã băm argon2id; mã đăng nhập chỉ lưu SHA-256 của chúng. Có xác minh hai bước
  tùy chọn bằng ứng dụng xác thực, kèm mã khôi phục.
- Mỗi tài khoản chỉ thấy sổ của mình: cơ sở dữ liệu bắt buộc điều đó (row-level security), và máy chủ kết nối
  bằng tài khoản không thể vượt qua nó.
- Đăng nhập, đăng ký và nhập mã đều bị giới hạn số lần thử. Không phân tích, không theo dõi, không script bên
  thứ ba.
- Trên trình duyệt, chỉ ứng dụng web của chính máy chủ mới dùng được API: bản sao ứng dụng web ở địa chỉ khác,
  hay bất kỳ trang web nào khác, đều bị từ chối. Ứng dụng di động kết nối được từ bao nhiêu điện thoại cũng được.
- Bạn chịu trách nhiệm về máy chủ của mình: cập nhật thường xuyên, dùng HTTPS khi truy cập từ máy khác, và sao
  chép bản sao lưu sang nơi khác.

Phát hiện lỗi bảo mật? Hãy báo riêng qua
[security advisories](https://github.com/LeeMinNguyeen/msaving/security/advisories/new) của GitHub, đừng mở issue công khai.

## Phát triển

```bash
git clone https://github.com/LeeMinNguyeen/msaving && cd msaving
docker compose up -d --build          # toàn bộ hệ thống từ mã nguồn này, tại http://localhost:8080
```

`backend/` là API (Python, FastAPI, PostgreSQL), `web/` là ứng dụng web (React, TypeScript). Mỗi thư mục có
`CLAUDE.md` ghi lệnh và quy tắc. Pull request gửi vào `dev`.

## Giấy phép

[GNU AGPL-3.0](LICENSE). Bạn được chạy, sửa và chia sẻ MSaving; nếu bạn chạy bản đã sửa cho người khác dùng, bạn
phải chia sẻ phần đã sửa với họ. Phần mềm không kèm bảo hành.
