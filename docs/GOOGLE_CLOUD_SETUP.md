# Google Cloud setup

Create a project controlled by the owner. In APIs & Services enable the **Photos Library API**. Do not create a service account or storage bucket.

In Google Auth Platform configure Branding (name, support email, authorized domain and privacy policy as required), Audience (External for personal Gmail), and Data Access. Add only photoslibrary.appendonly, photoslibrary.readonly.appcreateddata, and photoslibrary.edit.appcreateddata. Add the owner as a test user while testing.

Create a **Web application** OAuth client and register the full authorized redirect URI: append `/api/v1/google/callback` to your public `APP_URL`. For example, if `APP_URL` is `https://gallery.example.com`, register `https://gallery.example.com/api/v1/google/callback`. Set `GOOGLE_REDIRECT_URI` to the same value; the LAN address and published Docker port are not part of the callback. No trailing slash. Inject GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI server-side.

For sustained use, publish the consent screen as appropriate and complete verification Google requires for your audience and scopes. Publishing is not a guarantee of verification. External testing-mode refresh tokens for Photos access normally expire in seven days. Account storage, quota, revocation and policy restrictions still apply to private deployments.

Acceptance with real credentials: connect, grant all three requested permissions, Validate, send a new authorized group image, and check the album in the Google Photos account. Keep using the same account and OAuth project.
