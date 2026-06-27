# Tipster Kontrol Paneli

Admin ve tipster girisli Excel komisyon takip paneli.

## Calistirma

```text
npm start
```

## Ortam Degiskenleri

```text
PORT=3000
ADMIN_PASSWORD=guclu-admin-sifresi
DATA_DIR=/app/data
TRUST_PROXY=1
EMAIL_OTP_ENABLED=1
ADMIN_OTP_EMAIL=admin@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=admin@example.com
SMTP_PASS=mail-sifresi-veya-app-password
SMTP_FROM=admin@example.com
```

## Canli Yayinda

- `DATA_DIR` kalici disk alanina baglanmali.
- HTTPS arkasinda `TRUST_PROXY=1` kullanilmali.
- Admin sifresi canliya cikmadan degistirilmeli.
- E-posta onay kodu icin SMTP bilgileri Render ortam degiskenlerine girilmeli.
