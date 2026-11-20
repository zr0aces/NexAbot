# OAuth and provider restrictions

Start the connection while signed in at `https://dnbot.zerotrust.in.th`, not at the LAN IP. Google returns the browser to the [registered HTTPS callback](GOOGLE_CLOUD_SETUP.md), where NexAbot needs the original owner session cookie.

Authorization Code Flow requests offline access and explicit consent. One-time Redis state is bound to the signed-in session and expires in ten minutes. Refresh tokens are encrypted; access tokens stay server-side. Validate lists app-created albums. Reconnection checks an existing mapped album where available. No identity scope is requested, so the optional Google account ID can remain unset.

Disconnect removes the stored refresh token, not Google media. To revoke the grant at Google, remove the app under third-party account connections. Disconnect cannot recall in-flight requests; stop the worker for a hard cutover.

## Official documentation reviewed before implementation

- [API changes](https://developers.google.com/photos/support/updates): since March 31, 2025 Library API access is scoped to app-created content. The app cannot browse the owner's pre-existing library. No shared albums, legacy broad scopes or edit scope.
- [Upload media](https://developers.google.com/photos/library/guides/upload-media): upload bytes first, then create media. An upload token lasts one day; receiving it is not success. Inspect each batchCreate item even on HTTP 200/207. Create serially per user.
- [Manage albums](https://developers.google.com/photos/library/guides/manage-albums): at most 20,000 items per album. No overflow album. Sanitized titles are limited to 500 characters; a title is not an identifier.
- [Access media](https://developers.google.com/photos/library/guides/access-media-items): base URLs expire after about 60 minutes and may expire sooner. Resolve by media ID for remote display. Downloads need not be byte-identical to staged LINE bytes; Google can omit location metadata.
- [OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server) and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration): invalid_grant needs owner reauthorization.
- [API policies](https://developers.google.com/photos/support/api-policy): personal media only. Do not use this integration as a general-purpose Photos substitute, enterprise asset repository, public host or CDN.

No supported cross-service atomic commit, hash-based media search, or external exactly-once creation key exists for this workflow. A deterministic filename helps reconcile a positive match; an empty search is not proof the write failed.
