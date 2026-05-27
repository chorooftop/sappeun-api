# Kakao Apple Google Login Integration Plan

Status: active plan
Created: 2026-05-28
Last implementation update: 2026-05-28 KST
Target API: `/Users/oksang/Desktop/sappeun/sappeun-api`
Target mobile app: `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile`
Related app docs: `/Users/oksang/Desktop/sappeun/sappeun/docs/ENV.md`
Official docs checked:

- Supabase Flutter native `signInWithIdToken`: `https://supabase.com/docs/reference/dart/auth-signinwithidtoken`
- Supabase Google provider: `https://supabase.com/docs/guides/auth/social-login/auth-google`
- Supabase Apple provider: `https://supabase.com/docs/guides/auth/social-login/auth-apple`
- Supabase Kakao provider: `https://supabase.com/docs/guides/auth/social-login/auth-kakao/`
- Supabase identity linking: `https://supabase.com/docs/guides/auth/auth-identity-linking`
- Kakao Flutter Login: `https://developers.kakao.com/docs/en/kakaologin/flutter`
- Kakao Login prerequisites/OIDC: `https://developers.kakao.com/docs/en/kakaologin/prerequisite`
- Flutter `google_sign_in`: `https://pub.dev/packages/google_sign_in`
- Flutter `google_sign_in_android`: `https://pub.dev/packages/google_sign_in_android`

## Goal

Connect Kakao, Apple, and Google login for the Sappeun Flutter app while keeping Supabase Auth as the identity provider and `sappeun-api` as the privileged API boundary.

The API should not implement a custom OAuth identity server. Provider login should happen through native/mobile provider SDKs and Supabase Auth. After Supabase issues a session, Flutter sends `Authorization: Bearer <Supabase access_token>` to `sappeun-api`, and the API verifies the token with Supabase before serving profile, board, media, share, and account operations.

## 2026-05-28 Review Result

The first draft had the right architecture, but it was too light on execution details that usually break social login during implementation.

Gaps found and resolved in this revision:

- Google implementation must account for the current `google_sign_in` 7.x API. The old constructor plus `signIn()` pattern appears in some examples, but current package docs use `GoogleSignIn.instance.initialize(...)`, `authenticationEvents`, and `authenticate()`.
- Supabase requires both `idToken` and `accessToken` for Google `signInWithIdToken`; current `google_sign_in` exposes `idToken` through `GoogleSignInAuthentication` and access tokens through authorization APIs, so the plan now calls this out explicitly.
- Kakao has two viable Supabase paths: Supabase OAuth redirect and Kakao OIDC ID token exchange. The current mobile code is already on the native Kakao SDK plus ID token exchange path, so the plan now requires an explicit Kakao OIDC smoke gate.
- Apple login needs a release gate because Apple may require Sign in with Apple when the iOS app offers third-party social login providers.
- Supabase identity linking needs an explicit MVP decision. Automatic linking can work for verified same-email identities, but Kakao may have no email and Apple private relay email can create separate account outcomes.
- The plan needed a provider configuration matrix for Android debug, Android release, iOS debug, iOS release, and Supabase dashboard settings.
- Moving profile sync behind `sappeun-api` implies a follow-up RLS/security decision: the mobile app should eventually stop writing `profiles` directly.
- The smoke plan needed evidence fields, failure taxonomy, and token/log redaction rules.

Decision after review:

- Keep `POST /v1/users/me/auth-sync` as the first API-owned profile sync endpoint.
- Keep native sign-in plus Supabase `signInWithIdToken` as the provider exchange strategy.
- Treat manual account linking as post-MVP. MVP relies on Supabase automatic identity linking where verified emails match, and handles no-email/private-relay cases as separate account possibilities.
- Prioritize Kakao and Apple hardening before Google only if provider dashboard access is blocked; otherwise implement shared finalization first, then add Google.

## Current State

### API

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/auth/auth.service.ts` already validates Supabase bearer tokens with `supabase.anonClient.auth.getUser(token)`.
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/auth/supabase-auth.guard.ts` already supports protected Nest routes.
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/users/users.service.ts` already reads `profiles.primary_provider`, `first_login_at`, `last_seen_at`, `signup_completed_at`, and `onboarding_completed_at`.
- `POST /v1/users/me/auth-sync` is implemented in `sappeun-api`. It verifies the Supabase bearer token through the existing auth guard, creates or refreshes the profile row, derives `primary_provider` from verified Supabase auth metadata first, preserves user-edited profile fields, updates `last_seen_at`, and returns `requiresSignupConsent`.
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/config/env.ts` keeps only Supabase and server-side infrastructure keys. Provider secrets are not required in this API when Supabase owns OAuth exchange.
- Existing API plans already define Flutter bearer auth as the authenticated request contract.

### Mobile

- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/auth_bootstrap.dart` initializes Supabase and Kakao SDKs when env values are present.
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/kakao_sign_in_service.dart` obtains Kakao OIDC `idToken` and exchanges it through `OAuthProvider.kakao`.
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/apple_sign_in_service.dart` obtains Apple identity token with nonce handling and exchanges it through `OAuthProvider.apple`.
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/login_screen.dart` now shows Kakao, Apple, and Google buttons.
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/google_sign_in_service.dart` uses `google_sign_in` 7.2.0 with `GoogleSignIn.instance.initialize(...)`, `authenticate(...)`, `GoogleSignInAuthentication.idToken`, and `authorizationClient` access tokens for Supabase `OAuthProvider.google`.
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/auth_sync_api.dart` calls `POST /v1/users/me/auth-sync` with the Supabase access token when `API_BASE_URL` is configured.
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/supabase_auth_repository.dart` still has a direct `profiles` upsert fallback so login remains recoverable while API rollout catches up.

### Existing Provider Notes

- `/Users/oksang/Desktop/sappeun/sappeun/docs/ENV.md` says Google and Kakao are already enabled in the Supabase project used by the web app.
- Kakao email may be absent, so app identity must rely on Supabase user id and `profiles`, not email.
- Apple provider setup still needs explicit Supabase dashboard and Apple Developer verification before live device smoke.

## Product And Architecture Decisions

- Supabase Auth is the single source of truth for user identity.
- `sappeun-api` verifies Supabase sessions; it does not receive raw provider secrets or provider authorization codes.
- Mobile provider SDKs may receive public/native app identifiers, but service-role keys, OAuth client secrets, R2 credentials, and Supabase service-role secrets stay server-side or inside provider/Supabase dashboards.
- Profile sync should move from direct Flutter `profiles` upsert to an API-owned endpoint so the API can consistently set `primary_provider`, `first_login_at`, and `last_seen_at`.
- After API-owned profile sync is live, review and tighten client-side `profiles` write access so Flutter cannot accidentally bypass server profile rules.
- MVP scope is provider sign-in, profile sync, and guest-to-user continuation. Manual multi-provider account linking is out of scope unless Supabase Auth handles it safely through its configured identity behavior.
- Provider tokens are short-lived exchange inputs only. Do not persist provider `idToken`, provider `accessToken`, Supabase access token, or Supabase refresh token in app logs, analytics payloads, screenshots, crash reports, or support dumps.

## Non-Goals

- Do not build a custom OAuth callback server inside `sappeun-api` for this phase.
- Do not introduce email/password login in this phase.
- Do not add manual provider link/unlink UI in this phase.
- Do not migrate account deletion unless social login smoke uncovers a blocker in the current deletion path.

## Recommended Runtime Flow

1. Flutter initializes Supabase and available native provider SDKs.
2. User taps Kakao, Apple, or Google.
3. Provider SDK returns an ID token, and sometimes an access token.
4. Flutter calls `supabase.auth.signInWithIdToken(...)` for the provider.
5. Supabase returns a session and access token.
6. Flutter calls `POST /v1/users/me/auth-sync` with `Authorization: Bearer <Supabase access_token>` and, when present, `X-Sappeun-Guest-Session-Id`.
7. `sappeun-api` verifies the bearer token, upserts or updates the profile, and returns the current user/profile state.
8. Flutter runs guest adoption or guest media promotion, refreshes auth state, and routes the user to signup consent only when required.
9. Flutter discards provider tokens and keeps only the Supabase-managed session.

## API Contract

### New Endpoint

Add:

- `POST /v1/users/me/auth-sync`

Purpose:

- Verify current Supabase session.
- Ensure a profile row exists.
- Set `primary_provider` from Supabase user metadata or identities.
- Set `first_login_at` only when missing.
- Update `last_seen_at` on every successful sync.
- Copy provider display name and avatar only when local profile fields are empty or explicitly safe to refresh.
- Return the same high-level shape as `GET /v1/users/me` so mobile can reuse response parsing.
- Be idempotent across app restart, duplicate auth events, and retry after network failure.
- Never trust the request body provider more than the verified Supabase user identities.

Request:

```json
{
  "provider": "kakao | apple | google | optional",
  "displayName": "optional provider display name",
  "avatarUrl": "optional provider avatar URL"
}
```

Headers:

- `Authorization: Bearer <Supabase access_token>`
- `X-Sappeun-Guest-Session-Id: <uuid>` when converting a guest session

Response:

```json
{
  "user": {
    "id": "supabase-user-id",
    "email": "nullable",
    "phone": "nullable"
  },
  "profile": {
    "user_id": "supabase-user-id",
    "nickname": "nullable",
    "display_name": "nullable",
    "avatar_url": "nullable",
    "primary_provider": "kakao | apple | google | nullable",
    "first_login_at": "timestamp",
    "last_seen_at": "timestamp",
    "signup_completed_at": "nullable",
    "onboarding_completed_at": "nullable"
  },
  "requiresSignupConsent": true
}
```

Error policy:

- `401` when bearer token is missing, malformed, expired, or invalid.
- `400` for invalid request body shape.
- `409` only if a future explicit account-linking operation detects a provider identity conflict. MVP `auth-sync` should not invent provider conflict semantics that Supabase Auth has not produced.
- `500` for unexpected Supabase/profile persistence failures, with a generic message and no token/provider payload echo.

Profile sync rules:

- `primary_provider` is derived from Supabase `app_metadata.provider` first, then `identities[*].provider`, then validated request `provider`.
- `first_login_at` is set only if currently null.
- `last_seen_at` updates on every successful sync.
- `display_name`, `nickname`, and `avatar_url` should not be overwritten with null or blank provider data.
- User-edited nickname wins over provider display name.
- Apple display name should be accepted only when the native credential returns it, because Apple identity tokens do not include full name.
- Kakao email must remain optional.

### API Files To Change

Implemented:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/users/users.controller.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/users/users.service.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/users/users.service.spec.ts`

Not changed in this pass:

- `/Users/oksang/Desktop/sappeun/sappeun-api/src/auth/auth.types.ts`
- `/Users/oksang/Desktop/sappeun/sappeun-api/src/auth/auth.service.spec.ts`

## Provider Configuration Matrix

| Provider | Android debug | Android release/internal | iOS debug | iOS release/TestFlight | Supabase dashboard |
| --- | --- | --- | --- | --- | --- |
| Kakao | Android package, debug key hash, custom scheme | Release key hash and package name | Bundle id, custom scheme | Bundle id, custom scheme | Kakao provider enabled, REST API key/client secret, allow users without email if required |
| Apple | Not required for MVP unless Android Apple login is intentionally supported | Not required for MVP unless Android Apple login is intentionally supported | Sign in with Apple capability on bundle id | Capability, provisioning profile, App Review readiness | Apple provider configured for native iOS bundle id; Services ID/key only if OAuth/web/non-iOS flow is used |
| Google | Android package, debug SHA-1/SHA-256, web client id as server client id if no `google-services.json` | Release SHA-1/SHA-256, same web client id strategy | iOS client id and reversed client id config | iOS client id and release bundle id | Google provider enabled with OAuth web client id/client secret |

Build variants must be verified independently. A provider passing on debug does not prove release/internal builds are configured correctly.

## Provider Dashboard Status

Last updated: 2026-05-28 KST.

- Google Cloud project `sappeun` (`mythic-mission-496505-n4`) has an existing web OAuth client named `sappeun web`.
- `sappeun web` already includes Supabase redirect URI `https://wtptvgxyqkqqsfkdsoox.supabase.co/auth/v1/callback`.
- Google Cloud now has Android debug OAuth client `sappeun android debug` for package `com.sappeun.app` and debug SHA-1 `EE:9C:12:1A:79:E0:E9:AB:1C:96:5A:C4:F8:B8:E7:BF:30:12:47:69`.
- Google Cloud now has iOS OAuth client `sappeun ios` for bundle id `com.sappeun.app`.
- Google release/internal Android OAuth client is still pending because the release or Play App Signing SHA-1/SHA-256 values are not available locally.
- Apple Developer Program individual membership purchase was completed on 2026-05-28 KST.
- Apple account page still shows purchase processing guidance after purchase. Apple says purchase processing can take up to 48 hours.
- Direct access to Certificates, Identifiers & Profiles currently shows: `Unable to find a team with the given Team ID 'K5F3Y388N6' to which you belong.` This appears to be stale team selection from the previously connected unrelated organization.
- Do not create or modify `com.sappeun.app` under an unrelated Apple Developer organization team.
- Apple remains a release gate for iOS social login. Resume Apple setup after the individual membership finishes processing and the Apple Developer team switcher exposes the personal team.

### Apple Individual Account Path

- A corporation is not required for Sign in with Apple. Apple Developer Program can be enrolled as an individual or organization.
- Individual enrollment requires an Apple Account with two-factor authentication, legal adult status for the region, legal name, email, phone, and address. P.O. boxes are not accepted.
- For an individual membership, the App Store seller name is the developer's personal legal name, not a brand or service name.
- After individual membership is active, use the individual team to register the explicit App ID `com.sappeun.app`, enable the Sign in with Apple capability, and keep it as the primary App ID unless there are related apps/web identifiers to group.
- Supabase native iOS Sign in with Apple can use Apple's native Authentication Services path. OAuth/web or non-iOS Apple login requires Services ID, signing key `.p8`, generated client secret, and 6-month secret rotation.

## Provider Plan

### Kakao

Current mobile code already has the right general shape:

- `KakaoSdk.init(...)`
- `UserApi.instance.loginWithKakao(context, nonce: rawNonce)`
- `OAuthProvider.kakao`
- `signInWithIdToken(...)`

Implementation tasks:

- Confirm Kakao Developers has mobile app platform settings for Android package, Android key hashes, iOS bundle id, and custom URL scheme.
- Confirm Kakao OpenID Connect is enabled.
- Confirm Supabase Kakao provider is configured and accepts users without email.
- Keep email optional throughout UI, profile sync, and signup completion logic.
- Add smoke evidence for KakaoTalk-installed and Kakao account web fallback cases.
- Confirm OIDC remains ON. If Kakao OIDC is disabled later, mobile login will stop receiving `idToken`.
- Keep `loginWithKakao(context, nonce: rawNonce)` behind a small service wrapper so fallback behavior can be adjusted without touching controller/UI code.
- Verify native Kakao SDK token exchange against Supabase in staging before assuming parity with the web OAuth route.

### Apple

Current mobile code already has the right general shape for iOS:

- Generate raw nonce.
- Send SHA-256 nonce to Apple.
- Send raw nonce with Apple identity token to Supabase.
- Use `OAuthProvider.apple`.

Implementation tasks:

- Confirm Apple Developer Sign in with Apple capability for the app id.
- Confirm the selected Apple Developer team is Sappeun-owned before creating or editing identifiers.
- Confirm iOS bundle id, service id, key id, team id, and private key are configured where Supabase requires them.
- Confirm Apple login button is hidden or disabled on unsupported platforms.
- Preserve the fact that Apple email and full name may only be available on first authorization.
- Smoke test on a real iOS device, not only simulator.
- Confirm whether Apple App Review requires Apple login to be present because Kakao/Google social login are offered on iOS. Treat Apple login as release-blocking unless product/legal explicitly decides otherwise.
- Keep native iOS/macOS Apple login as the MVP path. Android/web Apple login uses OAuth-style settings and secret rotation, so it should remain out of scope unless product wants Apple login outside Apple platforms.

### Google

Google was the missing provider in the mobile app and is now implemented at the code level. Live smoke still depends on injecting the Google client IDs and verifying provider dashboard settings on device builds.

Recommended approach:

- Add a Google sign-in service in Flutter using the current `google_sign_in` package API.
- Initialize `GoogleSignIn.instance` with the iOS client id as `clientId` where needed and the Google web OAuth client id as `serverClientId`.
- Obtain Google `idToken` from `GoogleSignInAccount.authentication`.
- Obtain Google `accessToken` through the Google authorization client path. Supabase's native Google `signInWithIdToken` requires the access token.
- Exchange those tokens through Supabase with `OAuthProvider.google`.
- Use the same post-login finalization path as Kakao and Apple.

- [x] Add `google_sign_in` after checking current official package guidance.
- [x] Decide whether to use `google-services.json` for Android or pass `serverClientId` from dart define. Current implementation uses explicit dart defines.
- [x] Add `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_IOS_CLIENT_ID` to `AppEnvConfig`.
- [x] Add `GoogleSignInService`.
- [x] Add `googleSignInServiceProvider`.
- [x] Add `AuthController.signInWithGoogle()`.
- [x] Add a Google login button to `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/login_screen.dart`.
- [x] Add public mobile env values for Google client configuration.
- [ ] Inject real `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_IOS_CLIENT_ID` through Flutter build/run dart defines.
- Configure Google Cloud OAuth clients for Android and iOS, including package name, bundle id, and signing certificate fingerprints.
- Confirm Supabase Google provider client id and client secret are set in the Supabase dashboard.
- Add explicit handling for `GoogleSignInExceptionCode.clientConfigurationError` and the Android case where configuration errors can surface as cancellation.

## Mobile Files To Change

- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/pubspec.yaml`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/app/env.dart`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/application/auth_controller.dart`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/supabase_auth_repository.dart`
- New candidate: `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/google_sign_in_service.dart`
- New candidate: `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/infrastructure/auth_sync_api.dart`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/lib/features/auth/login_screen.dart`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/test/features/auth/auth_widgets_test.dart`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/test/features/auth/auth_state_test.dart`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/test/shared/infrastructure/sappeun_api_client_test.dart`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/android/app/src/main/AndroidManifest.xml`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/android/app/build.gradle.kts`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/ios/Runner/Info.plist`
- `/Users/oksang/Desktop/sappeun/sappeun/apps/mobile/ios/Runner.xcodeproj/project.pbxproj`

## Environment And Secret Policy

### Mobile Public Values

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `API_BASE_URL`
- `KAKAO_NATIVE_APP_KEY`
- `KAKAO_CUSTOM_SCHEME`
- Google public/native client identifiers, only if required by the selected Flutter package
- Candidate Google names:
- `GOOGLE_WEB_CLIENT_ID`
- `GOOGLE_IOS_CLIENT_ID`
- `GOOGLE_IOS_REVERSED_CLIENT_ID`

### Server Or Dashboard Only

- `SUPABASE_SERVICE_ROLE_KEY`
- Supabase provider client secrets
- Apple private key
- Google OAuth client secret
- Kakao client secret
- R2 credentials
- `R2_OWNER_HASH_SECRET`

## Observability And Privacy

Allowed evidence:

- Provider name.
- Build variant.
- Platform and OS version.
- API base URL origin only.
- Supabase project ref only.
- Smoke run timestamp.
- Success/failure status and sanitized error code.

Forbidden evidence:

- Provider ID tokens.
- Provider access tokens.
- Supabase access or refresh tokens.
- Supabase anon or service-role key values.
- R2 signed URLs, query strings, or object keys containing private identifiers.
- Full user email in public issue trackers or screenshots unless deliberately redacted.

Logging policy:

- Mobile logs can include provider name and high-level failure code.
- API logs can include request id, user id, provider, status code, and sanitized error class.
- Do not log request body for `auth-sync`.
- Add one request id to auth-sync responses if request tracing is already available; otherwise defer full logging infrastructure to the broader API observability plan.

## Implementation Phases

### Phase 1. Provider Dashboard And Env Readiness

- [ ] Confirm Supabase providers: Kakao, Apple, Google.
- [ ] Confirm Kakao app mobile platform settings and OIDC.
- [ ] Confirm Apple Developer capability and Supabase Apple credentials.
- [x] Confirm Google Cloud debug Android and iOS OAuth clients.
- [x] Decide final mobile env names for Google.
- [ ] Confirm Supabase Google credentials are still current after native app clients are added.
- [ ] Confirm Android release SHA-1/SHA-256 values and record where they are registered.
- [ ] Confirm iOS bundle id, URL schemes, and provisioning profile capability state.
- [ ] Fill `GOOGLE_IOS_REVERSED_CLIENT_ID` in iOS xcconfig after the real Google iOS client id is finalized.
- [x] Record provider dashboard state without capturing secrets.
- [x] Update `/Users/oksang/Desktop/sappeun/sappeun/docs/ENV.md` with mobile Google dart defines and auth-sync behavior.

### Phase 2. API Profile Sync

- [x] Add provider extraction helper for Supabase users.
- [x] Add `UsersService.syncAuthProfile(...)`.
- [x] Add `POST /v1/users/me/auth-sync`.
- [x] Preserve user-edited nickname when syncing provider names.
- [x] Return `requiresSignupConsent` from profile state instead of making Flutter infer it from a partially synced row.
- [ ] Decide whether `profiles` RLS/client write policy needs to be tightened after API sync ships.
- [x] Add unit tests for first login and nickname preservation.
- [x] Run `pnpm test`.
- [x] Run `pnpm build`.

### Phase 3. Mobile Login Finalization

- [x] Add an API client for `/v1/users/me/auth-sync`.
- [x] Refactor Kakao and Apple sign-in to call a shared post-login finalizer.
- [x] Prefer API profile sync when `API_BASE_URL` is configured.
- [x] Keep direct Flutter `profiles` upsert as a temporary fallback while API deployments catch up.
- [x] Keep auth state refresh and signup consent routing unchanged unless the API response shows a better signal.
- [ ] Add a cancellation-safe finalizer so provider cancellation never clears guest identity or queued media.
- [ ] Add `401` handling that refreshes Supabase session once, then routes to login if still invalid.
- [x] Add API serialization and login widget coverage for the new Google surface.
- [ ] Add deeper controller tests for success, cancellation, missing config, and sync failure.

### Phase 4. Google Login

- [x] Add Google sign-in dependency.
- [x] Implement `GoogleSignInService`.
- [x] Implement against the current `google_sign_in` singleton/initialize/authenticate API, not the older constructor/signIn API.
- [x] Retrieve both `idToken` and `accessToken`, and fail with a provider-specific message if either is missing.
- [x] Add `AuthController.signInWithGoogle()`.
- [x] Add Google provider button and disabled states.
- [x] Add tests that Kakao, Apple, and Google buttons are visible and respect provider readiness.
- [ ] Verify Android and iOS native config files after real Google/Apple values are injected.
- [ ] Add a debug checklist for Android `clientConfigurationError` and cancellation-like config failures.

Verification completed in this implementation pass:

- `pnpm test`
- `pnpm build`
- `flutter analyze`
- Targeted Flutter auth/API tests
- Login golden update and re-check for the added Google button

### Phase 5. Guest Continuation

- [ ] After login, call existing guest adoption APIs with `X-Sappeun-Guest-Session-Id`.
- [ ] Verify guest board state is attached to the authenticated user.
- [ ] Verify temporary guest media is promoted or remains recoverable according to the current board/media plan.
- [ ] Ensure login cancellation does not clear guest state.
- [ ] Make guest adoption retry idempotent. Duplicate login finalization should not duplicate boards/media.
- [ ] Verify signup consent completion and guest adoption order. Recommended order: auth sync -> consent if required -> adoption/promote -> board refresh.

### Phase 6. Device Smoke And Release Gate

- [ ] Kakao login on Android debug build.
- [ ] Kakao login on Android release-like internal build.
- [ ] Kakao login on iOS debug build.
- [ ] Kakao login on iOS TestFlight or release-like build.
- [ ] Apple login on real iOS device.
- [ ] Google login on Android debug build.
- [ ] Google login on Android release-like internal build.
- [ ] Google login on iOS debug build.
- [ ] Google login on iOS TestFlight or release-like build.
- [ ] Confirm `GET /v1/users/me` succeeds after each provider login.
- [ ] Confirm `profiles.primary_provider` is set correctly.
- [ ] Confirm `first_login_at` is stable and `last_seen_at` updates.
- [ ] Confirm no provider tokens, Supabase access tokens, service keys, or signed URL query strings appear in logs or screenshots.
- [ ] Confirm provider sign-out plus Supabase sign-out leaves no stale authenticated UI state.
- [ ] Confirm app restart restores Supabase session and does not rerun provider SDK login.

## Test Strategy

### API Tests

- Provider extraction from `app_metadata.provider`.
- Provider extraction from `identities[0].provider`.
- Missing provider falls back to `null` without failing login.
- Missing email is accepted.
- Profile insert sets `first_login_at`, `last_seen_at`, and `primary_provider`.
- Repeat sync preserves existing nickname and first login timestamp.
- Request body provider cannot override a verified Supabase provider.
- Blank provider display name and avatar do not erase existing profile fields.
- Invalid bearer token still returns `401`.
- Missing bearer token returns `401` for `auth-sync`.

### Mobile Tests

- Login screen shows Kakao, Apple, Google, and guest continuation actions.
- Buttons disable when Supabase or provider env is missing.
- Kakao cancellation returns a non-fatal cancellation failure.
- Apple unsupported platform disables the Apple action.
- Google cancellation follows the same cancellation UX as other providers.
- Google configuration failure is distinguishable from normal user cancellation where the plugin exposes a specific config error.
- Post-login finalizer calls API sync and invalidates auth state.
- Failed auth sync leaves the Supabase session intact but shows a retryable account setup error.
- Provider cancellation does not clear guest identity or queued media.

### Manual Smoke

- Fresh install, login with each provider, complete signup consent, restart app, confirm session restore.
- Login with provider when guest board/media exists, confirm guest content survives.
- Sign out and sign in again with the same provider, confirm no duplicate profile issue.
- Try Kakao user without email, confirm account screen still shows a usable provider/profile state.
- Try Apple first authorization and repeat authorization, confirm missing repeated name/email does not erase profile fields.
- Try Google debug and release-like builds because Android signing fingerprints differ.
- Try invalid/expired Supabase access token against `GET /v1/users/me` and verify mobile reauth behavior.

## Smoke Evidence Template

For each provider/platform/build variant, record:

```text
Run id:
Date:
Tester:
Provider:
Platform:
Build variant:
App version/build:
API origin:
Supabase project ref:
Guest session present before login: yes/no
Login result:
auth-sync result:
GET /v1/users/me result:
Guest adoption result:
Profile provider:
first_login_at behavior:
last_seen_at behavior:
Redaction check passed: yes/no
Notes:
```

## Risks

- Kakao may not return email. Treat email as optional everywhere.
- Apple may only return name and email on first authorization. Do not overwrite existing display fields with null.
- Google native setup can fail because of Android signing certificate fingerprint or iOS reversed client id mismatch.
- Supabase provider settings can differ between dev, preview, and production projects.
- Direct client profile upsert can diverge from API behavior if it remains in parallel too long.
- Guest adoption must be idempotent because users may retry after network failures.
- Provider tokens and Supabase access tokens must never be logged during debugging.
- Supabase automatic identity linking depends on verified email matches. Kakao no-email users and Apple private relay users may not link to an existing Google/email identity.
- Apple login may become an App Review blocker if Kakao/Google social login ships on iOS without Apple login.
- `google_sign_in` configuration errors can appear as user cancellation on Android, so smoke testers need a configuration checklist before treating repeated cancellation as user behavior.
- Provider dashboard changes can invalidate login without code changes. Keep dashboard state in release readiness notes.

## Success Criteria

- Kakao, Apple, and Google can each create a Supabase session in the mobile app.
- The resulting Supabase access token is accepted by `sappeun-api`.
- `POST /v1/users/me/auth-sync` creates or updates the profile idempotently.
- `GET /v1/users/me` returns the correct provider/profile state after login.
- Login does not require email for Kakao.
- Apple works on an actual iOS device.
- Google works on Android and iOS with release-like signing settings.
- Guest session data is not lost when the user logs in.
- API tests and mobile auth tests pass.
- Release-like Android and iOS builds pass provider smoke, not only debug builds.
- Dashboard/env state is documented with no leaked secrets.

## Open Questions

- Should Google appear before Apple on Android and after Apple on iOS, or should provider order stay fixed as Kakao, Google, Apple with unsupported Apple disabled?
- Do we want to support explicit account linking later, or let Supabase default identity behavior define duplicate-email handling for MVP?
- Should account deletion move fully behind `sappeun-api` before social login release, or remain on the current Supabase function path for the first provider smoke?
- Should Android Apple login remain unsupported for MVP, or should Apple be available cross-platform through OAuth-style flow later?
- Should `profiles.primary_provider` mean first provider, latest provider, or preferred provider after multiple linked identities? MVP recommendation: latest successful sign-in provider unless product wants a stable first-provider label.

## Official Docs Notes

- Supabase Flutter `signInWithIdToken` supports native Google and Apple sign-in. It marks Google `accessToken` as required and Apple raw nonce as required.
- Supabase Kakao docs describe both OAuth setup and ID token sign-in with provider `kakao`; the current mobile path depends on Kakao OIDC issuing an ID token.
- Supabase Apple docs warn that Apple full name is only available on first authorization and is not included in the identity token.
- Kakao docs require custom URL scheme setup for native Flutter and state that OIDC must be enabled for ID tokens.
- Kakao docs warn that turning OIDC off stops ID token issuance.
- Current `google_sign_in` package docs show version `7.2.0` and use singleton initialization plus `authenticate()`.
- `google_sign_in_android` docs say `serverClientId` is required if the app does not use `google-services.json` with a web OAuth client entry, and configuration errors can appear as cancellation.
- Supabase identity linking automatically links same verified-email identities, but no-email/private-relay cases still need product handling.
