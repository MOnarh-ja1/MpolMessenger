# MPOL Messenger 2.0 Preview — status and safety

**This is a preview of the existing MPOL Messenger, NOT a full Telegram/Discord replacement.**

## Implemented in this preview

- Persistent Neon PostgreSQL for accounts, friends, chat history and new attachments (existing server retained).
- WebSocket presence, message sync, incoming friend requests and reconnection (already present; preserved).
- Private Saved Messages ("Избранное") in a one-member server chat.
- Per-account chat archive, without deleting messages.
- Persistent message emoji reactions with WebSocket updates.
- Profile photo upload (PNG/JPG/WEBP, up to 800 KB), stored in PostgreSQL.
- Real voice notes using microphone consent, MediaRecorder, playback preview, server upload and playback.
- In-app emoji picker with basic keyword search; GIF images can be attached as files.
- Chat filters: all, direct, groups, unread, archived.
- Image preview; copy message text.
- WebRTC voice/video call flow with incoming call, accept/decline, microphone/camera toggles, screen sharing, and signaling through authenticated WebSocket **with STUN only**.
- Original ID, profiles, chats, groups and existing server endpoints remain in place.

## Explicitly NOT complete / verified

- **TURN server is not configured.** The WebRTC path can fail across strict firewalls/NATs. Calls between two independent PCs have not been tested; automated tests cover signaling, not media transport.
- **No end-to-end encryption.** HTTPS/WSS encrypt transport, but server administrators can access server-side data.
- Native Windows toast/background notifications when the app is closed are not implemented. Browser notifications may work when the window is minimized and permission is granted.
- No verified production-ready moderation, antivirus scanning, independent security audit, database backup/restore drills or persistent always-on hosting.
- No full sticker catalogue or GIF provider integration; uploads are possible.
- Group invite links, folders, complex roles and pinned/forwarded messages are not finished.
- SMTP email recovery remains dependent on external SMTP configuration.
- The Go EXE opens a dedicated installed-browser app window, **not a native WPF window**; Windows custom titlebar requirements are not fully implemented.

## Database changes

Only new tables are added via SQLAlchemy `Base.metadata.create_all()` at service boot:

- `chat_archives` (composite primary key)
- `message_reactions` (composite primary key)
- `profile_photos` (binary data)

No existing users, IDs, messages, attachments, or groups are dropped or rewritten. A production migration/backup strategy should replace startup `create_all` before a major general release. Current alpha test size limitations: 12 MB attachments and 800 KB avatars.

## Smoke test

Run `python tests/test_friend_realtime.py` and `python tests/test_mpol2.py` on local test DB only, then `node --check client/ui/app.js`, `node --check client/ui/voice.js`, `node --check client/ui/calls.js`. GitHub Windows Actions builds the EXE and ZIP on successful push to main.

This preview should **not** be advertised as fully implemented until all 2.0 requirements are independently tested.
