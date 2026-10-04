# bdApps PHP Bridge API

bdApps-এর সাথে আমাদের backend সরাসরি কথা বলে না। মাঝখানে একটা PHP bridge আছে। bridge-এর ৪টা ফাইল bdApps-এর আসল API ডাকে:

```
Backend (lib/bdappsOtp.ts)  →  PHP bridge  →  bdApps
```

এই ডকুমেন্টের কোনো অফিসিয়াল সোর্স নেই। bdApps-এর দেওয়া Flutter (Dart) sample code আর bridge-এ পাঠানো কয়েকটা test request থেকে এটা লেখা। প্রতিটা তথ্যের পাশে লেখা আছে সেটা কোথা থেকে জানা গেছে:

- **[Dart]** Dart sample code-এ স্পষ্টভাবে ব্যবহার করা হয়েছে।
- **[পরীক্ষিত]** bridge-এ request পাঠিয়ে নিজে দেখা হয়েছে।
- **[অনুমান]** code দেখে ধারণা করা, নিশ্চিত না।

## সাধারণ নিয়ম

| বিষয় | মান |
|---|---|
| Base URL | `https://bdapps.flicksize.com/mealager/api/` (env: `BDAPPS_*_URL`)। Dart sample-এ অন্য অ্যাপের URL ছিল: `https://www.bdappsdigitalapps.com/NADB26015/` |
| Method | সবসময় `POST` **[Dart]** |
| Request body | `application/x-www-form-urlencoded`, JSON না **[Dart]** (Dart-এর `http.post`-এ `body` হিসেবে Map দিলে form-encoded যায়) |
| Response | JSON object **[Dart]** |
| মোবাইল নম্বর | ১১ সংখ্যার লোকাল ফরম্যাট `01XXXXXXXXX`, `+88`/`88` ছাড়া **[Dart]** |
| সমর্থিত অপারেটর | শুধু Robi/Airtel: `^01(6|8)\d{8}$` **[Dart]** |
| Timeout | Dart-এ check-এর জন্য 10s, বাকিগুলোর জন্য 15s |

### bdApps status code

| Code | মানে |
|---|---|
| `S1000` | সফল **[Dart]** |
| `E1351` | নম্বরটা আগেই registered/subscribed **[Dart]** |

### Subscription status (`subscriptionStatus`)

| মান | মানে | অ্যাপে ঢুকতে দেবে? |
|---|---|---|
| `REGISTERED` | subscription চালু, billing নিশ্চিত | হ্যাঁ **[Dart]** |
| `INITIAL CHARGING PENDING` | subscription হয়েছে, প্রথম charge এখনো বাকি | হ্যাঁ **[Dart]** |
| `UNREGISTERED` | subscribed না | না **[Dart]** |
| অন্য যেকোনো কিছু / field নেই / error | subscribed না ধরতে হবে | না **[Dart]** |

---

## 1. `check_subscription.php`

নম্বরটা এখন subscribed কিনা জানায়।

**Request**

| Field | Type | বাধ্যতামূলক | বিবরণ |
|---|---|---|---|
| `user_mobile` | string | হ্যাঁ | `01XXXXXXXXX` |

**Response**

```json
{ "subscriptionStatus": "REGISTERED" }
```

- Dart শুধু `subscriptionStatus` পড়ে। মানটা trim করে uppercase করে তুলনা করে। **[Dart]**
- HTTP status 200 না হলে, বা JSON object না এলে subscribed না ধরে। **[Dart]**
- ভুল বা খালি নম্বর দিলে: **[পরীক্ষিত]**
  ```json
  { "error": "Invalid mobile number format", "providedNumber": "" }
  ```

---

## 2. `send_otp.php`

নম্বরে subscription-এর OTP পাঠায়।

**Request**

| Field | Type | বাধ্যতামূলক | বিবরণ |
|---|---|---|---|
| `user_mobile` | string | হ্যাঁ | `01XXXXXXXXX` |

Dart শুধু `user_mobile` পাঠায়। আমাদের backend নিরাপত্তার জন্য একই মান `mobile`, `mobileNumber`, `phone` নামেও পাঠায়। এতে কোনো সমস্যা হয় না।

**সফল Response** **[Dart]**

```json
{ "success": true, "referenceNo": "..." }
```

`success === true` এবং `referenceNo` খালি না হলেই সফল। `referenceNo` রেখে দিতে হবে, verify-এর সময় লাগবে।

**ব্যর্থ Response** **[Dart]**

```json
{ "success": false, "statusCode": "E1351", "message": "...", "statusDetail": "..." }
```

- `statusCode == "E1351"` বা `message`-এ `already registered` থাকলে নম্বরটা আগেই subscribed। তখন OTP লাগবে না। `check_subscription` দিয়ে নিশ্চিত হয়ে সরাসরি login করাতে হবে।
- দেখানোর মতো error message: আগে `message`, না থাকলে `statusDetail`।
- **[অনুমান]** `E1351` কখনো কখনো `data.statusCode`-এর ভেতরেও আসতে পারে। আমাদের backend দুই জায়গাতেই খোঁজে।

---

## 3. `verify_otp.php`

User-এর দেওয়া OTP যাচাই করে। সফল হলে bdApps subscription চালু করে।

**Request** **[Dart]**

| Field | Type | বিবরণ |
|---|---|---|
| `Otp` | string | OTP (বড় হাতের `O`) |
| `otp` | string | একই OTP, ছোট হাতের নামে |
| `referenceNo` | string | `send_otp` থেকে পাওয়া reference |
| `reference_no` | string | একই reference, অন্য নামে |
| `user_mobile` | string | `01XXXXXXXXX` |

Dart একই মান কয়েকটা নামে পাঠায়, কারণ bridge ঠিক কোন নামটা পড়ে সেটা নিশ্চিত না। আমাদের backend-ও এই পাঁচটা field-ই পাঠায়।

OTP-এর মেয়াদ ৪ মিনিট (Dart UI-তে 240 সেকেন্ডের timer)। OTP ৪ থেকে ৬ সংখ্যার।

**সফল Response** **[Dart]**, নিচের যেকোনো একটা হলেই সফল:

- `statusCode` (বা `StatusCode` / `status_code`) == `"S1000"`
- `success === true`
- `status` বা `result` == `"success"`

**ব্যর্থ Response**: error message পাওয়া যাবে `message`, `statusDetail`, `error` বা `errorMessage` field-এ, এই ক্রমে খুঁজতে হবে। **[Dart]**

**Verify-এর পরের ধাপ** **[Dart]**: OTP সফল হলেও bdApps-এ subscription চালু হতে একটু সময় লাগে। Dart প্রতি ১ সেকেন্ড পর পর, সর্বোচ্চ ৫ বার, `check_subscription` ডাকে। `REGISTERED` বা `INITIAL CHARGING PENDING` পেলে তবেই login করায়। আমাদের backend এখনো এটা **করে না**, কারণ মাস্কিং চালু থাকলে এই যাচাই কখনো পাস করে না। মাস্কিং বন্ধ হওয়ার পর যোগ করা যাবে।

---

## 4. `unsubscribe.php`

নম্বরের subscription বাতিল করে।

**Request**

| Field | Type | বাধ্যতামূলক | বিবরণ |
|---|---|---|---|
| `user_mobile` | string | হ্যাঁ | `01XXXXXXXXX` |

**সফল Response** **[Dart]**, নিচের যেকোনো একটা হলেই সফল:

- `success === true`
- `statusCode == "S1000"`
- `subscriptionStatus == "UNREGISTERED"` (uppercase করে তুলনা)

**ব্যর্থ Response**

- Dart error message হিসেবে `statusDetail` দেখায়। **[Dart]**
- নম্বর না দিলে: **[পরীক্ষিত]**
  ```json
  { "error": "Mobile number required" }
  ```
- `E1951`: `Format of the address is invalid Or User Already UnRegistered` **[পরীক্ষিত]**। দুইটা কারণে আসে: নম্বরটা সত্যিই subscribed না, অথবা অ্যাপে **number masking** চালু আছে। মাস্কিং চালু থাকলে bdApps নম্বর এনক্রিপ্ট করে রাখে, তাই `check_subscription` আর `unsubscribe` আসল নম্বর দিয়ে কাউকেই খুঁজে পায় না। অথচ `send_otp` তখনও "already registered" বলে। মাস্কিং বন্ধ করতে support@bdapps.com-এ মেইল করতে হয়। আমাদের backend এই error পেলে user-কে error-ই দেখায়, কখনো সফল ধরে নেয় না।

HTTP status 200 না হলে ব্যর্থ। **[Dart]**

---

## পুরো Flow

```
Login:
  check_subscription ──► REGISTERED / PENDING ──► সরাসরি login
          │
          └─► অন্য কিছু ──► send_otp
                              ├─► success + referenceNo ──► OTP screen ──► verify_otp
                              │                                   └─► সফল ──► check_subscription poll (5×1s) ──► login
                              └─► E1351 / already registered ──► check_subscription poll ──► login

Unsubscribe:
  unsubscribe ──► সফল ──► local login state মুছে login screen-এ পাঠাও
```
