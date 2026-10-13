/* Orbit — all user-facing UI strings in one place (localization-ready).
 * Use OrbitStrings.t('key', {var: value}). Add a language by adding another object to LOCALES.
 */
(function (root) {
  'use strict';
  if (root.OrbitStrings) return;
  const brand = (root.ORBIT && root.ORBIT.BRAND_NAME) || 'Orbit';

  const en = {
    brand,
    close: 'Close', back: 'Back', cancel: 'Cancel', save: 'Save', done: 'Done', copy: 'Copy', copied: 'Copied!', delete: 'Delete',
    edit: 'Edit', reply: 'Reply', remove: 'Remove', more: 'More', ok: 'OK', search: 'Search', loading: 'Loading…', retry: 'Retry',
    settings: 'Settings', profile: 'Profile', rooms: 'Rooms', you: 'you', add: 'Add', open: 'Open', clear: 'Clear', next: 'Next', skip: 'Skip', finish: 'Let’s go',

    // rooms screen
    rooms_title: 'Rooms', room_name_label: 'Room name', room_name_placeholder: 'e.g. study group', room_code: 'Room code', room_code_placeholder: 'abcde',
    youll_join: 'You’ll join: {name}', youll_join_empty: 'Type a name — same name = same room, anywhere.',
    add_password: 'Add a password (optional)', password_placeholder: 'Password (shared out-of-band)',
    password_help: 'Messages and images are AES-GCM encrypted with a key derived from the five-letter room code + password.',
    join_or_create: 'Join or create', join_room: 'Join room', create_room: 'Create room', joining: 'Connecting…', creating_room: 'Creating…', joining_room: 'Checking code…',
    join_room_help: 'Enter the room code shared by its creator. The creator must be online for the room to be available.', create_room_help: 'Choose a display name. Orbit will generate a five-letter code to share with others.', password_optional: 'PASSWORD (OPTIONAL)',
    youll_create: 'Room name: {name}', youll_create_empty: 'Choose a name for your room.', room_code_help: 'Enter the five-letter code shared by the room creator.', room_code_ready: 'Code: {code}', room_created: 'Created “{name}” · code {code}', copy_code: 'Copy code', code_copied: 'Room code copied.', room_not_found: 'No active room found for that code. Check the code/password and confirm a member is online.', room_code_in_use: 'That code is already in use. Use Join room instead.', legacy_room_no_code: 'This saved room predates room codes. Create a new room and share its code.',
    pinned: 'Pinned', pin_message: 'Pin message for everyone', unpin_message: 'Unpin message', retry_image: 'Retry / resume image transfer', handoff_notice: '@everyone · Host handoff complete', recent: 'Recent', connected_rooms: 'Connected', no_rooms: 'No rooms yet. Type a name above — if nobody is there, you simply become the first member.',
    online_count: '{n} online', online_help: 'People currently connected to this room', unread_count: '{n} unread', pin: 'Pin', unpin: 'Unpin', pin_room: 'Pin to top', unpin_room: 'Unpin', pin_room_help: 'Keep this room at the top of your list', unpin_room_help: 'Let this room return to its usual position', invite_help: 'Copy an invite with the room code to share', offline_saved: 'Offline · saved on this device', rejoin_help: 'Try to reconnect using this room’s code', delete_room_memory: 'Delete memory', delete_room_memory_help: 'Permanently remove this room and its saved chat history from this device', delete_room_memory_confirm: 'Delete “{name}” and its saved messages and images from this device? This cannot be undone.', leave_room_help: 'Disconnect from this room; you can rejoin later', remove_room: 'Remove', remove_room_help: 'Remove this saved room from your list', forget_room: 'Remove from list', rejoin: 'Rejoin',
    room_full: '“{name}” is full ({max} people). Try another name.', invite: 'Copy invite',
    invite_text: 'Join my {brand} room “{name}” with code {code}: install {brand}, click the dot and enter the code under Join room.',
    invite_copied: 'Invite copied — paste it to a friend.', quick_switch_placeholder: 'Jump to room…', no_results: 'Nothing found',

    create_poll: 'Create poll', poll_question: 'Poll question', poll_option: 'Option {n}', add_option: 'Add option', remove_option: 'Remove option',
    poll_multiple: 'Allow multiple choices', poll_closes: 'Close poll after', poll_never: 'Never', poll_5m: '5 minutes', poll_1h: '1 hour', poll_1d: '1 day',
    poll_vote: 'Vote', poll_votes: '{n} votes', poll_closed: 'Poll closed', poll_close: 'Close poll', poll_change_vote: 'You can change your vote', poll_saved: 'Poll posted.', poll_tap_vote: 'Choose an option to vote. You can change your vote.', poll_multiple_short: 'Multiple choice', poll_single_short: 'Single choice', poll_closes_at: 'Closes at {time}', poll_need_question_options: 'Add a question and at least two options.',
    share_file: 'Share files', attachment_limit: 'You can attach up to four files at once.', voice_message: 'Voice message', audio_file: 'Audio', file_attachment: 'File', voice_get: 'Get voice message', file_waiting: 'Waiting for a peer…', asset_not_available: 'This attachment is not available on a connected device yet.', share_file_help: 'Send a document or any other file', file_get: 'Get file', file_download: 'Download', file_receiving: 'Receiving {pct}%', file_ready: 'Ready to download', video_attachment: 'Video', image_attachment: 'Image', preview_loading: 'Loading preview…', preview_failed: 'Preview unavailable — use the download button', preview_show: 'Show preview', preview_expand: 'Click to enlarge',
    voice_record: 'Record a voice message', voice_stop: 'Stop recording', voice_play: 'Play voice message', voice_load: 'Load voice message', voice_permission: 'Microphone permission is needed to record.', voice_unavailable: 'Voice recording is not available in this browser.', voice_saved: 'Voice message sent.', voice_recording: 'Recording… {seconds}s left',
    attachment_uploading: 'Preparing {name}…', attachment_failed: 'Could not send {name}.', file_too_large: 'Files must be 50 MB or smaller.', large_file_title: 'Large file warning', large_file_warning: '{name} is {size}. Files over 25 MB can take a while to send. Continue?',

    // room screen
    status_connected: 'Connected to {n} {people}', status_waiting: 'Waiting for others to join…', status_connecting: 'Connecting…',
    status_reconnecting: 'Reconnecting…', status_offline: 'You’re offline', status_full: 'Room is full', status_error: 'Connection error — retrying',
    people_one: 'person', people_many: 'people',
    typing_one: '{a} is typing…', typing_two: '{a} and {b} are typing…', typing_many: 'Several people are typing…',
    composer_placeholder: 'Message #{room}', composer_hint: 'Enter to send · Shift+Enter for a new line · / for commands',
    send: 'Send', attach_image: 'Add image', emoji: 'Emoji', stickers: 'Stickers', members: 'Members', leave_room: 'Leave room',
    clear_history: 'Clear room history (local only)', clear_history_confirm: 'Delete all locally stored messages and images for this room? Other members keep their copies.',
    room_options: 'Room options', share_history: 'Share history with newcomers', share_history_help: 'Offer the last ~200 messages (text + small thumbnails) to people who join later.',
    nickname_in_room: 'Nickname in this room', nickname_placeholder: 'Leave empty to use your display name',
    mute_room: 'Mute room', mute_1h: 'Mute for 1 hour', mute_8h: 'Mute for 8 hours', mute_tomorrow: 'Mute until tomorrow', mute_forever: 'Mute until I turn it back on', unmute: 'Unmute', muted: 'Muted',
    keeper: 'keeper', keeper_help: 'The member who has been here the longest. Keeper actions are cooperative, not enforced.',
    rename_room: 'Rename room (cosmetic)', rename_prompt: 'New display title', mute_member: 'Mute for everyone', unmute_member: 'Unmute for everyone', muted_by_keeper: 'muted by keeper',
    edited: 'edited', deleted: 'This message was deleted', seen_by: 'Seen by {names}', new_messages: '{n} new', jump_to_bottom: 'Jump to latest', load_earlier: 'Load earlier messages',
    today: 'Today', yesterday: 'Yesterday', reply_to: 'Replying to {name}', editing: 'Editing message', jump_to_reply: 'Jump to replied message',
    react: 'React', copy_text: 'Copy text', copy_image: 'Copy image', download: 'Download', zoom_in: 'Zoom in', zoom_out: 'Zoom out', prev: 'Previous', next_img: 'Next',
    image_receiving: 'Receiving {pct}%', image_sending: 'Sending {pct}%', image_missing: 'Click to fetch from peers', image_waiting: 'Waiting for sender…',
    image_too_big: 'Image is larger than {mb} MB', gif_too_big: 'Animated GIFs must be under {mb} MB', unsupported_image: 'Only PNG, JPEG, WebP and GIF images are supported',
    images_max: 'Up to {n} images per message', drop_hint: 'Drop images to send', sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', pending: 'Will deliver when someone joins',
    search_placeholder: 'Search this room…', search_results: '{n} results', sticker_add: 'Add sticker', sticker_add_help: 'Small images you reuse; shared with the room when you send them.',
    sticker_remove: 'Remove sticker', sticker_saved: 'Sticker saved', save_as_sticker: 'Save as sticker', no_stickers: 'No stickers yet — add one with the + button.',
    mention_hint: 'Mention', me_action: '{name} {text}', system: 'system', pin_open: 'Pin open', unpin_panel: 'Unpin', compact: 'Compact',
    room_not_joined: 'You left this room', history_cleared: 'History cleared', copied_name: 'Name copied',
    mute_person: 'Mute this person', unmute_person: 'Unmute this person', copy_name: 'Copy name', muted_person_hint: 'You won’t see messages from this person.',
    slash_help: 'Commands: /me action · /shrug · /clear · /nick Name · /roll 2d6 · /flip · /mute name · /leave',
    unknown_command: 'Unknown command {cmd}. {help}', nick_set: 'You’re now “{name}” in this room', left_room: 'Left #{name}', joined_room: 'Joined #{name}',
    roll_result: '🎲 rolled {dice}: {rolls} = {total}', flip_result: '🪙 {result}', heads: 'Heads', tails: 'Tails', shrug: '¯\\_(ツ)_/¯',
    muted_user: 'Muted {name}', unmuted_user: 'Unmuted {name}', no_such_member: 'No member named “{name}”',
    link_preview_loading: 'Loading preview…',

    // profile
    profile_title: 'Profile', display_name: 'Display name', display_name_help: 'Up to {n} characters', avatar: 'Profile picture',
    avatar_upload: 'Upload', avatar_generated: 'Generated', avatar_emoji: 'Emoji', choose_image: 'Choose image…', banner: 'Banner', status_line: 'Status',
    status_placeholder: 'heads-down, gaming, …', presence: 'Presence', presence_online: 'Online', presence_away: 'Away', presence_dnd: 'Do not disturb', presence_invisible: 'Invisible',
    name_color: 'Name color', default_color: 'Default', export_profile: 'Export profile', import_profile: 'Import profile', import_ok: 'Profile imported', import_bad: 'That file is not an {brand} profile',
    crop_title: 'Adjust your picture', zoom: 'Zoom', crop_use: 'Use picture', crop_hint: 'Drag to reposition', avatar_note: 'Stored locally as a small 128×128 image (under 20 KB). Metadata is stripped.',
    per_room_nick: 'Per-room nickname', preview: 'Preview', suggested_status: 'Suggestions',

    // settings
    appearance: 'Appearance', theme: 'Theme', theme_light: 'Light', theme_dark: 'Dark', theme_auto: 'Auto (system)', accent: 'Accent', custom: 'Custom',
    font_size: 'Font size', compact_mode: 'Compact mode', message_style: 'Message style', style_bubble: 'Bubbles', style_flat: 'Flat',
    panel_side: 'Panel side', left: 'Left', right: 'Right', dot_size: 'Dot size', dot_opacity: 'Dot idle opacity', panel_opacity: 'Panel opacity', panel_width: 'Panel width',
    chat_background: 'Chat background', bg_none: 'None', bg_pattern: 'Pattern', bg_image: 'Image', bg_upload: 'Upload image…', bg_blur: 'Blur', bg_dim: 'Dim',
    bg_scope: 'Apply to', bg_global: 'All rooms', bg_room: 'This room only', reduce_motion: 'Reduce motion', peek_mode: 'Peek latest message on hover',
    notifications: 'Notifications & privacy', desktop_notifications: 'Desktop notifications', sound: 'Notification sound', sound_name: 'Sound', test_sound: 'Test',
    notify_on_mention: 'Notify on @mention even when a room is muted', dnd_schedule: 'Do Not Disturb schedule', from: 'From', to: 'To',
    hidden_sites: 'Hide on these sites', add_site: 'Add site', site_placeholder: 'example.com', never_show_here: 'Never show on this site ({host})', show_here_again: 'Show on this site again ({host})',
    hide_1h: 'Hide everywhere for 1 hour', hidden_until: 'Hidden until {time}', unhide_now: 'Unhide now',
    auto_hide_fullscreen: 'Auto-hide the dot in fullscreen video/games', boss_key: 'Boss key ({keys}) hides everything and mutes sounds instantly.',
    link_previews: 'Link previews', link_previews_warning: 'Off by default: fetching a preview contacts the linked site from your browser, which reveals your IP address to it.',
    exif_note: 'Every image you send is re-encoded before sending, which strips EXIF metadata (including GPS location). Animated GIFs are sent as-is.',
    clear_all_data: 'Clear all local data', clear_all_confirm: 'This deletes your profile, settings, rooms, message history and cached images on this browser. Continue?',
    data_cleared: 'All local data cleared',
    advanced: 'Advanced', signaling: 'Peer discovery (signaling)', signaling_help: 'PeerJS PeerServer brokers WebRTC setup. The room creator is the room host and must stay online to relay messages to members.',
    sig_peerjs: 'PeerJS cloud (recommended)', sig_nostr: 'Nostr relays', sig_mqtt: 'MQTT brokers', sig_torrent: 'BitTorrent trackers',
    ice_servers: 'STUN / TURN servers (JSON)', ice_help: 'No free public TURN exists any more. If peers cannot connect, add your own (free tiers: metered.ca Open Relay, Cloudflare TURN), e.g. {"urls":"turn:host:3478","username":"u","credential":"p"}.',
    ice_invalid: 'Invalid JSON — expected an array of {urls, username?, credential?}', ice_saved: 'ICE servers saved — rooms will reconnect',
    diagnostics: 'Connection diagnostics', run_diagnostics: 'Refresh', diag_none: 'Join a room to see diagnostics.', peer: 'Peer', state: 'State', rtt: 'RTT', relays: 'Signaling relays', candidate: 'Path',
    test_connection: 'Test connection', testing_connection: 'Testing…', connection_test_help: 'Checks PeerJS signaling, gathers host/STUN/TURN ICE candidates, and pings each online member through the room’s host-routed path. Keep another member online for the remote round-trip check.', connection_test_signaling: 'PeerJS signaling', connection_test_ice: 'ICE candidate gathering', connection_test_peers: 'Room-member round-trip checks', connection_test_no_peers: 'No other room members are online, so a remote peer-to-peer check was not possible.', connection_test_no_candidates: 'No ICE candidates gathered', connection_test_errors: 'ICE server errors', connection_test_elapsed: 'Test time', connection_test_ping_ok: 'round-trip OK', connection_test_ping_fail: 'no ping reply', connection_test_not_joined: 'Room is no longer active.' ,
    max_image_mb: 'Max image size (MB)', image_cache_mb: 'Image cache limit (MB)', cache_used: 'Cache used: {mb} MB', toolbar_icon: 'Toolbar icon', icon_color: 'Color', icon_mono: 'Monochrome (auto light/dark)',
    shortcuts_hint: 'Shortcuts: {toggle} toggle panel · {boss} boss key · Esc close · / focus composer · Ctrl+K room switcher. Change them at chrome://extensions/shortcuts',
    schema_version: 'Data schema v{v}',

    // onboarding
    tour1_title: 'This is your dot', tour1_body: 'It floats on every website. Drag it up or down, snap it to either edge, right-click it for options. It pulses when you have unread messages.',
    tour2_title: 'Rooms have five-letter codes', tour2_body: 'Create a room to get a code like abcde, then share it — anyone who enters that code (and the password, if you set one) lands in the same room. The code is the room address, not the display name.',
    tour3_title: 'Make it yours', tour3_body: 'Tap your avatar to set a name, picture, status and colors. Everything stays in your browser — no account, no server.',

    // misc
    boss_active: 'Boss mode is on — press {keys} to restore', extension_reloaded: '{brand} was updated — reload this page to keep chatting.', toast_error: 'Something went wrong: {msg}',
    connected_people: '{n} connected', nobody_here: 'nobody else here yet', peek_latest: 'latest', full_time: '{date} at {time}',
    confirm_leave: 'Leave #{name}? You can rejoin any time by name.', unsaved: 'Unsaved changes', ratelimited: 'Slow down a little',
    reset_defaults: 'Reset to defaults', image_cache: 'Image cache size', muted_people: 'Muted people', restricted_note: 'This page blocks extensions, so {brand} opened in the side panel instead.',

    // rejoining / recovery (everyone left, browser restarted, room code still reserved)
    status_claiming: 'Reclaiming this room…', room_reserved_note: 'Your previous session still holds this code — reclaiming it now.',
    rejoin_failed_offline: 'Could not reach the room yet — retrying in the background. Keep this panel open.',
    rejoin_retry_hint: 'Nobody is hosting that code yet. {brand} keeps retrying and joins as soon as a member comes online.',
    room_claimed_back: 'You are hosting “{name}” again — code {code}.',
    room_open_again: '“{name}” is reachable again.',

    // screen sharing
    screen_share: 'Share screen', screen_share_help: 'Show a tab, window or your whole screen to the room (video only, no sound)',
    screen_starting: 'Starting screen share…', screen_denied: 'Screen sharing was cancelled or blocked by the browser.',
    screen_unavailable: 'This browser cannot capture a screen here.', screen_relay_blocked: 'Screen sharing needs a direct peer-to-peer link, and this connection is going through the relay — video would not survive it. Try again in a moment or add a TURN server in Advanced settings.',
    screen_busy: '{name} is already sharing a screen. One share at a time, please.',
    screen_live: 'LIVE', screen_shared_by_you: 'You are sharing your screen', screen_shared_by: '{name} is sharing their screen',
    screen_stop: 'Stop sharing', screen_hide: 'Hide', screen_show: 'Show stream', screen_close: 'Close stream',
    screen_watching: '{n} watching', screen_waiting: 'Waiting for the first frame…', screen_stopped: 'Screen sharing stopped.',
    screen_stopped_by_keeper: '{name}’s screen share was stopped by the room keeper.',
    screen_refresh: 'Refresh video', screen_refresh_help: 'Ask the sharer for a fresh keyframe (useful after switching tabs)',
    screen_keeper_stop: 'Stop the screen share', screen_fullscreen: 'Fullscreen', screen_quality: 'Quality',
    screen_q_low: 'Low', screen_q_med: 'Medium', screen_q_high: 'High', screen_q_help: 'Lower quality keeps weak connections smooth',
    screen_needs_direct: 'This member reaches the room through the relay, so screen video cannot be sent to them.',
    screen_tab_tip: 'Tip: a window or the whole screen keeps going when you switch tabs — a shared tab freezes while it is in the background.',
    screen_and_you: '{name} is sharing their screen', screen_started: '{name} started sharing their screen.',

    // about / downloads
    about: 'About', about_version: 'Version {v}', about_repo: 'Source code on GitHub',
    about_repo_help: 'Download the newest build, read the docs, report a bug or open a pull request.', about_download: 'Download ZIP',
    about_releases: 'Releases', about_issues: 'Report a problem', about_license: 'MIT licensed · PeerJS and Trystero bundles are MIT.'
  };

  const LOCALES = { en };
  let current = en;

  function t(key, vars) {
    let s = current[key] != null ? current[key] : (en[key] != null ? en[key] : key);
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }
  function setLocale(code) { current = LOCALES[code] || en; }

  root.OrbitStrings = { t, setLocale, LOCALES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
