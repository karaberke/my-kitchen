# Social sign-in (Google, Microsoft, Apple)

Password sign-in stays. Each provider appears only when its credentials are set,
so an install that configures none behaves exactly as before.

## Quick start

1. Pick a provider below and follow its steps to get a client id and secret.
2. Add the two (or three, for Apple) `.env` variables for it and restart:
   `docker compose up -d` (or `./deploy.sh` again).
3. Its button appears on the sign-in page automatically — nothing else to wire up.

Google is the least involved: free, no waiting period, and works the moment the
two variables are set. Start there if you just want to try it.

## The redirect URI

Every provider needs this registered, with your real origin:

```
<ORIGIN>/api/auth/callback/<provider>
```

for example `https://kitchen.example.com/api/auth/callback/google`. The provider
names are `google`, `microsoft` and `apple`.

This is why a stable `ORIGIN` matters. Providers require exact redirect URIs and
allow no wildcards, so `deploy.sh --quick-tunnel`, whose hostname is random per
run, cannot be used with social sign-in. A LAN address like `192.168.1.20` is
also rejected by Google; `http://localhost` is allowed for local development.

## Google

1. console.cloud.google.com → APIs & Services → Credentials.
2. Create an OAuth client ID, type "Web application".
3. Add the redirect URI above.
4. Put the client id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Microsoft

1. entra.microsoft.com → App registrations → New registration.
2. Under "Supported account types" pick personal **and** work accounts if family
   members use Outlook or Hotmail addresses.
3. Add the redirect URI above as a Web platform.
4. Certificates & secrets → new client secret.
5. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and leave
   `MICROSOFT_TENANT_ID=common` unless you are restricting to one directory.

## Apple

Apple needs a paid Apple Developer Program membership and is the only one that
does not stay configured indefinitely.

1. developer.apple.com → Certificates, Identifiers & Profiles.
2. Create an **App ID**, then a **Services ID** — the Services ID is what goes in
   `APPLE_CLIENT_ID`, not the bundle identifier.
3. Enable "Sign in with Apple" on the Services ID and add the redirect URI above.
4. Create a **Key** with Sign in with Apple enabled and download the `.p8`. It is
   downloadable exactly once.
5. Apple has no static client secret: it is a JWT signed with that key, carrying
   your Team ID and Key ID. Generate it and put it in `APPLE_CLIENT_SECRET`.

**Apple secrets expire.** Apple rejects a client secret JWT older than six
months, so this must be regenerated on a schedule or Apple sign-in stops working
with no other warning. Set `APPLE_APP_BUNDLE_IDENTIFIER` only if a native app
shares these accounts.

Two further Apple quirks: the user's name is returned only on the _first_
authorisation, and "Hide My Email" gives a per-app relay address rather than the
real one.

## How accounts join up

`requireLocalEmailVerified` is on, so a social account is **never** merged into an
existing password account automatically. This closes the pre-hijack attack, where
someone registers your email address first and waits for your social sign-in to be
folded into their account. It matters here because this app has no mail transport,
so every password account is unverified.

The consequence: existing members sign in with their password, then link the
provider deliberately under **Settings → Sign-in methods**. After linking, either
method works. The last remaining way in cannot be removed.

## Invitation-only installs

`REGISTRATION_OPEN=false` still means what it says. A social callback creates users
through neither `/register` nor Better Auth's blocked sign-up endpoint, so without a
gate, enabling a provider would quietly reopen sign-ups. The `user.create.before`
hook applies the same policy: a first-time social sign-in is refused unless
registration is open or the visitor arrived through a valid invitation link, whose
token the invite page parks in a short-lived cookie so it survives the round trip
to the provider and back.
