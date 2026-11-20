# LINE setup

1. Create a LINE Official Account in [Official Account Manager](https://manager.line.biz/). Under Settings enable Messaging API and select the correct provider. Open the resulting channel in [LINE Developers](https://developers.line.biz/console/).
2. Enable group chat participation under Messaging API. LINE permits only one Official Account in a group at a time. Issue an access token; get the channel secret from Basic settings.
3. Enter both in Settings or inject LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET. Saved settings override environment values. The token is checked against bot info; only a signed webhook can verify the channel secret.
4. In RivoSnap Settings, copy the **Webhook URL** into LINE Developers. It is your public `APP_URL` followed by `/api/webhooks/line`. LINE must be able to reach it from the internet; a successful LAN check is not sufficient. Click Verify, enable Use webhook and Webhook redelivery. The empty signed verification batch is valid. Do not require proxy login or transform request bodies on this path.
5. Explain collection to group participants. Invite the Official Account, open LINE groups, enable collection and send a new image. Check Upload queue, then Gallery.

[Message content](https://developers.line.biz/en/reference/messaging-api/#get-content) expires after a provider-controlled period. Download promptly; redelivery does not restore expired content. LINE bytes may differ from camera originals. No history retrieval, direct messages or rooms. Video collection is disabled by default and can be enabled in Settings.

Official references checked before implementation: [receiving messages](https://developers.line.biz/en/docs/messaging-api/receiving-messages/), [signature verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/) and [group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/).
