# Connecting GMC Manager to Google Merchant Center – step by step

> Audience: whoever sets up an instance. The overall installation is described in
> [operations.md](operations.md); this page covers only the Google Cloud / Merchant Center side.
> For Google Search Console see [operations.md §4.2](operations.md#42-google-search-console-optional-product360).

Time needed: ~15 minutes, plus a wait of up to 5 minutes for Google after step 4.
You need: admin access to the Merchant Center account, and a Google account that
can create a Google Cloud project (any Google account works; it does not have to
be the one used for Merchant Center).

## Operator login – Google OAuth

Production installations use Google OAuth for the operator session. This is
separate from the service account: OAuth proves who is using the app, while the
service account performs scheduled Merchant API and Search Console work on the
server. The app does not store Google OAuth refresh tokens or service-account
private keys in the browser.

1. In Google Cloud → **APIs & Services → OAuth consent screen**, configure the
   application and add the operator account as a test user if the app is not
   published.
2. Create an **OAuth client ID → Web application**.
3. Add this exact authorized redirect URI:
   `https://YOUR_PUBLIC_HOST/api/auth/google/callback`.
4. Put the client ID, client secret, and the same redirect URI in the server
   environment as `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and
   `GOOGLE_OAUTH_REDIRECT_URI`.

The login page then shows **Continue with Google**. Only after Google login
does the setup wizard ask for the Merchant Center service-account key and
account id. Keep `LOCAL_LOGIN_ENABLED=false` in production; it is enabled
automatically by the synthetic demo and may be enabled deliberately for local
development.

The Merchant API needs **four** things, and all four must be in place –
any one of them missing produces an error that looks like a credentials problem:

| # | What | Where |
|---|------|-------|
| 1 | Merchant API **enabled** in a Google Cloud project | Google Cloud console |
| 2 | A **service account** + JSON key in that project | Google Cloud console |
| 3 | The service-account e-mail added as a **user of the Merchant Center account** | Merchant Center |
| 4 | The Google Cloud **project registered as a developer** with the Merchant Center account | wizard button (or API) |

Step 4 is new in the Merchant API (the old Content API did not have it) and is
the one that produces the message
*"GCP project with id … is not registered with the merchant account"*.

---

## Step 1 – Enable the Merchant API in Google Cloud

1. Open <https://console.cloud.google.com/> and sign in.
2. In the project picker (top bar) select an existing project or **New project**
   (any name, e.g. `gmc-manager`). Note the **project id** – you will see it in
   error messages (e.g. `my-shop-437721`).
3. Open <https://console.cloud.google.com/apis/library/merchantapi.googleapis.com>
   (make sure the right project is selected in the top bar) and click **Enable**.

> Billing does not need to be enabled for the Merchant API.

## Step 2 – Create a service account and download its key

1. In the same project go to **IAM & Admin → Service accounts**
   (<https://console.cloud.google.com/iam-admin/serviceaccounts>).
2. **Create service account**: name e.g. `gmc-manager`, click **Create and continue**.
   You can skip the "Grant this service account access to project" step – no
   Cloud IAM role is needed (access is granted inside Merchant Center instead).
   Click **Done**.
3. Click the new service account → tab **Keys** → **Add key → Create new key →
   JSON → Create**. A file `…json` is downloaded. Keep it private; it is the password.
4. Copy the service account's e-mail address, it looks like
   `gmc-manager@my-shop-437721.iam.gserviceaccount.com`.

## Step 3 – Add the service account as a user in Merchant Center

1. Open <https://merchants.google.com/> and select the account (the **account id**
   is the number in the top-right corner / in the URL, e.g. `1234567890`).
2. Go to **Settings (gear icon) → People and access** (older UI:
   *Settings → Account access → Users*).
3. **Add person / + Add user**, paste the service-account e-mail from step 2.4,
   choose **Admin** access and save. (Standard access is enough to read, but the
   app needs Admin to create data sources, return policies, notification
   subscriptions and to perform step 4.)
4. Important details:
   * Add it **directly on the account you will use**, not only on a parent
     "advanced account" (MCA). Developer registration (step 4) checks direct
     membership.
   * The account must be a **production account** (not a Merchant Center *test
     account*) and its **website must be verified and claimed**
     (*Settings → Business information → Website*). Google refuses step 4 otherwise.

## Step 4 – Register the Google Cloud project with the Merchant Center account

This links the project from step 1 to the Merchant Center account. Do it once
per project/account pair.

**In the wizard (recommended):**

1. Open the app → setup wizard → *Connection*. Enter the account id, upload the
   JSON key, click **Test connection**.
2. If Google answers *"… is not registered with the merchant account"*, a yellow
   **Register Google Cloud project** box appears. Enter the e-mail address of a
   **person** who is an admin of the Merchant Center account (a real Google
   account – *not* the service account; Google sends API notifications there)
   and click **Register**.
3. Wait up to 5 minutes, click **Test connection** again – it should now show the
   account name and the number of data sources. Continue with the wizard.

**Alternative – from the command line** (same thing the button does):

```bash
# access token for the service account (needs the gcloud CLI):
gcloud auth activate-service-account --key-file=service-account-key.json
TOKEN=$(gcloud auth print-access-token --scopes=https://www.googleapis.com/auth/content)

curl -X POST "https://merchantapi.googleapis.com/accounts/v1/accounts/ACCOUNT_ID/developerRegistration:registerGcp" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"developerEmail":"admin@your-company.com"}'
```

Reference: <https://developers.google.com/merchant/api/guides/quickstart/direct-api-calls#step_1_register_as_a_developer>

## Troubleshooting the *Test connection* messages

| Message | Meaning / fix |
|---------|---------------|
| *GCP project … is not registered with the merchant account* | Step 4 not done (or done less than 5 minutes ago). Use the **Register** box. |
| *Registration failed* (403 / 400) | Service account not added *directly* on the account (step 3.4), account is a test account, website not verified/claimed, or the developer e-mail is not an admin of the account. |
| *The caller does not have permission* (403) after registration | Service account is not a user of the account (step 3), or the Merchant API is not enabled in the project (step 1). |
| *Requested entity was not found* (404) | Wrong account id. Use the number of the account itself, not of a parent account. |
| *invalid_grant* / *DECODER routines::unsupported* | The JSON key is corrupted/incomplete (e.g. pasted partially). Upload the original file. |
| *Merchant API has not been used in project … or it is disabled* | Step 1 – enable the API in exactly the project that owns the service account. |

---

## `SESSION_SECRET` (and `WEBHOOK_SECRET`) – where do they come from?

They are **your own random strings**, not something Google gives you. The app
uses `SESSION_SECRET` to sign login cookies and to encrypt the stored service
account key in the database. Generate a long random value once and keep it:

```bash
# Linux / macOS
openssl rand -hex 32
# or with Node
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```powershell
# Windows PowerShell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Put the result in `.env`:

```
SESSION_SECRET=4f9c1e…(64 hex characters)
```

Notes:
* If you change `SESSION_SECRET` later, all users are logged out and the stored
  service-account key can no longer be decrypted – the wizard will simply ask for
  the key again.
* `WEBHOOK_SECRET` can be generated the same way, or with the **Generate** button
  in the wizard (it becomes part of the URL Google calls for push notifications).
