# MSaving

Ứng dụng theo dõi chi tiêu do bạn tự chạy, cho bạn, gia đình hoặc một nhóm nhỏ. Dữ liệu tiền bạc nằm trên máy
hoặc máy chủ của chính bạn: không ai khác vận hành nó, và dự án không thu thập gì.

*English: [README.md](README.md)*

- Nhiều sổ (cá nhân, gia đình, kinh doanh nhỏ), mỗi sổ một loại tiền, chia sẻ nếu muốn
- Tài khoản bằng bất kỳ loại tiền nào: tiền mặt, ngân hàng, tiết kiệm, đầu tư, thẻ tín dụng, khoản vay, cho vay
- Chi tiêu, thu nhập, chuyển khoản, hoàn tiền, có lịch sử chỉnh sửa; danh mục, ngân sách, trang tổng quan
- Ai nợ ai: tiền cho vay và đi vay, theo từng người
- Tỷ giá hằng ngày, không cần tài khoản hay khóa nào
- Tải toàn bộ dữ liệu dưới dạng CSV dễ đọc; xóa tài khoản bất cứ lúc nào
- Tiếng Việt và tiếng Anh

Miễn phí và mã nguồn mở ([AGPL-3.0](LICENSE)).

## Bắt đầu nhanh

Trên bất kỳ máy nào có [Docker](https://docs.docker.com/engine/install/):

```bash
mkdir msaving && cd msaving
curl -O https://raw.githubusercontent.com/LeeMinNguyeen/msaving/main/docker-compose.yml
docker compose up -d
docker compose logs msaving       # mã thiết lập
```

Mở http://localhost:8080, nhập mã thiết lập và tạo tài khoản: tài khoản này là quản trị viên của máy chủ.

## Tài liệu

Tài liệu đầy đủ (tiếng Anh): **[https://msaving.leminhnguyen.com/docs/](https://msaving.leminhnguyen.com/docs/)**. Cài đặt, mời người khác, HTTPS cho thiết bị khác, cập nhật, sao lưu,
cài đặt tùy chọn, cách hoạt động và đóng góp mã nguồn.

Phát hiện lỗi bảo mật? Hãy báo riêng qua
[security advisories](https://github.com/LeeMinNguyeen/msaving/security/advisories/new), đừng mở issue công khai.

## Giấy phép

[GNU AGPL-3.0](LICENSE). Bạn được chạy, sửa và chia sẻ MSaving; nếu bạn chạy bản đã sửa cho người khác dùng, bạn
phải chia sẻ phần đã sửa với họ. Phần mềm không kèm bảo hành.
