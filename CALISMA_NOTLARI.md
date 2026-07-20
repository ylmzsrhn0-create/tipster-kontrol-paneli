# Tipster Kontrol Paneli - Calisma Notlari

Son guncelleme: 2026-07-09

## Bugun Yapilanlar

- Tipster numara girisi duzeltildi:
  - `05321234567`, `5321234567`, `+90 532 123 45 67` gibi girisler sistemde `0532***4567` formatina cevrilecek.
  - Tipster numara girisindeki eski sadece maskeli format zorlamasi kaldirildi.
- Gunluk Excel hesabi duzeltildi:
  - Gunluk Excelde `Toplam Tutar` olmasa da tarih sutunlari uzerinden hesaplama yapabilecek.
- Logo ve arka plan calismasi yapildi:
  - `logo-watermark.png` canliya yuklendi.
  - Ana giris sayfasinda logo gizlendi.
  - Logo sadece kullanici giris yaptiktan sonra panel arka planinda gorunecek sekilde ayarlandi.
- Bakim/guncelleme ekrani iyilestirildi:
  - Kullaniciya "Size daha iyi hizmet verebilmek adina kendimizi gelistiriyoruz" mesaji gosterilecek.
  - Duz hata yazilari yerine daha profesyonel bir bakim ekrani hazirlandi.
- Canliya gonderilen dosyalar:
  - `server.js`
  - `public/index.html`
  - `public/style.css`
  - `public/app.js`
  - `public/sw.js`
  - `public/maintenance.html`
  - `public/logo-watermark.png`

## Bilinen Durum

- GitHub uzerinden dosya yukleyerek canliya aliyoruz.
- Render yeni dosyalari bazen birkac dakika gec aliyor.
- Tarayici/service worker onbellegi bazen eski gorunumu gosterebiliyor; bu yuzden surum parametresi ve cache guncellemeleri kullanildi.

## 20.07.2026 Gorev Kaydi

- Hesap makinesi sag altta kucuk simge olarak acilir/kapanir hale getirildi.
- Ana bolumler bilgisayarda ve telefonda sayfa gibi acilacak sekilde duzenlendi.
- Islem gecmisi, Pasif numaralar ve Excel yukleme bolumlerinde, icerideki tipster/alt basliklara tiklayinca sayfanin geri kapanmasina neden olan hata duzeltildi.
- Canli surum kontrol edildi: `panel-inner-click-fix-20260719a`.
- Bayi Portal haftalik liste eslesmesi guclendirildi: tam numara, 90 ile baslayan numara ve maskeli numara ilk 4 / son 4 hane mantigiyla ayni sekilde eslesir.
- Giris ekranina `Beni hatirla` kutusu eklendi. Isaretliyse oturum suresi 30 gun olur; sifre tarayicida kaydedilmez.
- Canli surum kontrol edildi: `portal-match-remember-20260720a`.
- Bayi Portal telefon okuma tekrar genisletildi: ayni Excel hucresinde birden fazla numara, bosluklu numara, `+90`, basinda 0 olmayan numara, `***`, `xxx` ve benzeri maskeli yazimlar okunacak sekilde duzeltildi.
- Canli surum kontrol edildi: `portal-match-exact-20260720b`.
- Tipsterlar icin telefon/web bildirimi altyapisi eklendi:
  - Admin mesaj attiginda tipstera bildirim gider.
  - Admin haftalik Excel yuklediginde tipsterlara bildirim gider.
  - Tipster ilk giriste `Bildirimleri ac` penceresi gorur.
  - Tipster isterse panel icinden de bildirimleri acabilir.
- Canli surum kontrol edildi: `push-notifications-20260720a`.

## Sonraki Profesyonel Oneriler

1. Adminlere ozel logo yukleme:
   - Her admin kendi logosunu yukleyebilsin.
   - O adminin tipster panelinde sadece kendi logosu gorunsun.
   - Ana giris sayfasi ortak ve tarafsiz kalsin.

2. Tipster numara ekleme onizlemesi:
   - Tipster numarayi yazarken altta "Kaydedilecek format: 0532***4567" gosterilsin.
   - Yanlis numarada daha acik uyari verilsin.

3. Excel yukleme durum paneli:
   - Haftalik Excel, gunluk Excel ve Bayi Portal listesi ayri durum kutularinda gorunsun.
   - "Son yuklenen", "satir sayisi", "tipstersiz numara" daha net gorunsun.

4. Admin ana ekranini sadeleştirme:
   - En cok kullanilan bolumler yukarida kalsin.
   - Diger bolumler kapali/akordeon gelsin.
   - Mobilde daha rahat gezilsin.

5. Islemlerin daha guclu kaydi:
   - Numara ekleme/silme, Excel yukleme/silme, odeme kaydi gibi islemler daha ayrintili tutulabilir.
   - Gerekirse CSV/Excel olarak disari alinabilir.

6. Guvenlik iyilestirmeleri:
   - Adminler icin e-posta kodu oturumu daha net hale getirilebilir.
   - Kritik islemlerde tekrar onay istenebilir.

7. Yedek ve geri alma:
   - Excel silinse bile o haftaya ait ozetlerin arsivde kalmasi secenekli yapilabilir.
   - Yanlis yukleme durumunda "geri al" mantigi eklenebilir.
