# MPOL: planned voice servers and rooms (next version, not v3.7)

Voice rooms are separate from the existing group chat and direct WebRTC calls.

## Sidebar
- A **Servers** icon in the left navigation matching the existing graphite MPOL icons.
- Clicking opens the **Servers** pane, with a list of servers the signed-in member can access.
- A **Create server** control opens a form for server name, icon (optional) and privacy; no fake non-working buttons.

## Within a server
- Member list and a server-specific invitation flow to add or invite friends.
- Text sections plus one or more voice rooms visible to authorized members.
- Click to join/leave a voice room, with microphone mute, speaker control, speaking indicator and optional screen sharing.
- Room permissions: owner/admin/member; invite links or approvals with time limits; kick and remove member controls.
- Explicit permission for audio/screen share; show who is currently connected; no secret or passive recording.

## Technical prerequisites
- New persistent models for servers, memberships and rooms in the existing Neon PostgreSQL database.
- Separate authorization on every endpoint and signaling event.
- A group-call architecture (SFU recommended when several participants connect): adding each member as a separate P2P connection does not scale.
- TURN alone does not provide group mixing or SFU; free relays cannot guarantee quality.
- Keep user accounts, friends, DMs and previous messages unchanged.

## Sequence
1. MPOL 3.7 — voice assistant with safe, confirmed actions in existing chats, calls and groups.
2. Server backend and membership invitations.
3. Dedicated Servers sidebar / server creation screen.
4. Joinable voice rooms, connection quality controls and multiuser screen sharing.

No voice servers or rooms are claimed to be functional in MPOL 3.7.
