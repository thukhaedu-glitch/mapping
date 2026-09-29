# StoreRadar — Competitor & trade-area map (multi-tenant SaaS)

ဆိုင်ခွဲတွေနဲ့ ပြိုင်ဘက်ဆိုင်တွေကို မြေပုံပေါ်တင်ပြီး အကွာအဝေး၊ ဆိုင်အရွယ်အစား၊ radius အတွင်း လူဦးရေ၊ area activity (ရုံး/ကျောင်း/mall) တွေကို နှိုင်းယှဉ်တဲ့ tool ပါ။
Company တစ်ခုချင်းစီက ကိုယ့် workspace နဲ့ login ဝင်ပြီး data ခွဲသုံးလို့ရတယ် (multi-tenant)။

## ဘာတွေလုပ်လို့ရလဲ
| Feature | How |
|---|---|
| ဆိုင် manual ထည့်တာ | **+ Add store** → map ပေါ်နှိပ်၊ ဒါမှမဟုတ် Google Maps link paste |
| Excel import | **Import Excel** (.xlsx/.csv) — `Template` ကို download ပြီး ဖြည့်ပါ။ Lat/Lng မရှိရင် Google Maps link တစ်ခုတည်းနဲ့ ရတယ်။ Brand အသစ်တွေ auto ဖန်တီးတယ်။ |
| Google Places ရှာတာ | **Find** tab — ရလာတဲ့ result ကို brand name/alias နဲ့ auto-match လုပ်ပြီး *pending* အဖြစ်ထည့်၊ လူက verify လုပ် |
| အကွာအဝေး / radius | ဆိုင်နှိပ် → အနီးဆုံးပြိုင်ဘက်၊ 500m–5km အတွင်း ပြိုင်ဘက်အရေအတွက် (brand အလိုက်)၊ ဆိုင်အရွယ် vs ပြိုင်ဘက်ပျမ်းမျှ |
| လူဦးရေ | WorldPop grid ထည့်ထားရင် radius အတွင်း estimated residents |
| Area activity (အလုပ်အကိုင် proxy) | OpenStreetMap ကနေ ရုံး၊ ကျောင်း၊ ဆေးရုံ၊ mall၊ ဘဏ်၊ စားသောက်ဆိုင် အရေအတွက် (live, free) |
| Analysis | ကိုယ့်ဆိုင်တိုင်းအတွက် trade-area comparison table (sort / Excel export) |
| Export map | **⤓ Export map** — JPG 3000px / 6000px, PDF A3 (map + analysis table) |
| Brand logo | Brands & Team → **+ Logo** (PNG/JPG/SVG/WebP)။ 128px အထိ ချုံ့ပြီး Firestore ထဲသိမ်း (~3–15KB) → Firebase Storage/Blaze မလို။ Map pin၊ list၊ legend၊ JPG/PDF export မှာ ပေါ်တယ်။ Map ပေါ်က **Logos** toggle နဲ့ ပိတ်/ဖွင့် |
| Team | Owner / Admin / Editor / Viewer roles, email invite |

## ၁။ Demo နဲ့ စမ်းကြည့်ရန် (Firebase မလို)
`public/js/firebase-config.js` ဗလာထားရင် demo mode (data က browser ထဲမှာပဲ)။
```bash
cd public && python3 -m http.server 8000     # http://localhost:8000
```
Brands & Team → **Load fictional sample data** (brand/ဆိုင်တွေ အကုန် စိတ်ကူးယဉ်)။

## Map tiles (နောက်ခံ map)
`public/js/firebase-config.js` → `mapTiles`
- Key မထည့်ရင် **OpenStreetMap** tiles (free, key မလို)။ OSM policy အရ internal/low traffic အတွက်ပဲ — export ကို 3000px အထိ ကန့်ထားတယ်။
- SaaS ရောင်းမယ်ဆို **MapTiler** free key (https://cloud.maptiler.com, လစဉ် tile 100k) ယူပြီး `maptilerKey` ထည့် → domain restrict လုပ်ပါ။ 6000px print export ဖွင့်မယ်။
- CARTO က အခု API key လိုလာလို့ default မဟုတ်တော့ဘူး။

## ၂။ Firebase နဲ့ Deploy
1. https://console.firebase.google.com → project အသစ်
2. **Authentication** → Email/Password + Google enable
3. **Firestore Database** → create (region: `asia-southeast1` Singapore)
4. Project settings → Web app ထည့် → config ကို `public/js/firebase-config.js` မှာ ကူးထည့်
5. `.firebaserc` ထဲ project ID ပြောင်း
6. Deploy:
```bash
npm i -g firebase-tools && firebase login
firebase deploy --only hosting,firestore        # Spark (free) plan နဲ့ ရတယ်
```

### Google Places search (optional — Cloud Functions လိုတယ်)
Cloud Functions သုံးဖို့ **Blaze plan** (card ချိတ်) လိုတယ်။ Free quota အတွင်းဆို ပိုက်ဆံမကျဘူး၊ ဒါပေမဲ့ Google Cloud မှာ **budget alert** ထားပါ။
```bash
# Google Cloud Console → enable "Places API (New)" → API key ဖန်တီး (API restriction: Places API only)
firebase functions:secrets:set PLACES_API_KEY
cd functions && npm i && cd ..
firebase deploy --only functions
```
Search တစ်ခါ = Places request ၃ ခုအထိ (result 60)။ Workspace တစ်ခုချင်း လစဉ် quota (`functions/index.js` → `QUOTA`): free 30 / pro 500 / business 3000 searches။ ဈေးနှုန်းက Google ဘက်က ပြောင်းတတ်လို့ Google Maps Platform pricing page မှာ စစ်ပါ။

## ၃။ လူဦးရေ layer (WorldPop — free)
1. https://hub.worldpop.org → Population Counts → Myanmar → 100m GeoTIFF download
2. ```bash
   pip install rasterio numpy
   python tools/build_pop_grid.py mmr_ppp_2020_constrained.tif --year 2020
   ```
   → `public/data/pop_grid.json` (Yangon, Mandalay, Naypyitaw, Bago, Mawlamyine, Taunggyi, Pathein; 250m cells)။ မြို့ထပ်ထည့်ရန် `--bbox "Myeik:12.40,98.55,12.50,98.65"`။
3. Redeploy hosting။

⚠️ WorldPop က model estimate ပဲ။ 2021 နောက်ပိုင်း လူရွှေ့ပြောင်းမှုတွေ မပါဘူး။ ဆိုင်တွေကို အချင်းချင်း နှိုင်းယှဉ်ဖို့ သုံးပါ၊ absolute number အဖြစ် client ကို မကတိပေးပါနဲ့။

## Data model (Firestore)
```
users/{uid}                 { email, orgId }
invites/{email}             { orgId, orgName, role, invitedBy }
orgs/{orgId}                { name, ownerUid, plan }
orgs/{orgId}/members/{uid}  { email, role: owner|admin|editor|viewer }
orgs/{orgId}/brands/{id}    { name, color, isOwn, aliases[], logo: "data:image/webp;base64,…" }
orgs/{orgId}/stores/{id}    { brandId, name, lat, lng, address, township, city,
                              sizeSqft, seats, type, status: verified|pending|closed,
                              source: manual|excel|google_places, placeId, notes }
orgs/{orgId}/usage/{YYYY-MM} { placesSearches }   ← Cloud Function ပဲ ရေးလို့ရ
```
Security rules: member မဟုတ်ရင် org data ကို ဖတ်/ရေး မရ၊ viewer က ဖတ်ပဲရ၊ `plan` ကို client ကနေ ပြောင်းလို့မရ (billing backend ကပဲ)။

### Rules test (emulator)
```bash
cd tests && npm i && npm test        # Java 11+ လိုတယ်
```

## SaaS ရောင်းဖို့ ကျန်တာ
- Billing (Stripe / local payment: KBZPay, WavePay) → webhook က `orgs/{id}.plan` ကို Admin SDK နဲ့ update
- Plan အလိုက် store limit (e.g. free 100 stores) — Cloud Function trigger နဲ့ enforce
- Custom domain + landing page
- Shared "market data" layer — မင်း verify လုပ်ထားတဲ့ competitor data ကို subscriber တွေကို ရောင်းတဲ့ model (တကယ့်တန်ဖိုးက ဒီမှာ)

## Stack
Vanilla JS (no build step) · Leaflet + OSM / MapTiler tiles · SheetJS · jsPDF · Firebase Auth/Firestore/Hosting/Functions · Overpass API · WorldPop
