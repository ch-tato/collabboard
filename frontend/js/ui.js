// =============================================================================
// CollabBoard — UI Controller
// =============================================================================
// Owner : M2 (Frontend Engineer)
// Sprint: Day 3
//
// Implements the Room Join/Create modal interactions and the Participant
// Sidebar updates using the WebSocket events from NetworkManager.
// =============================================================================

'use strict';

(function initUI() {
    console.log('[CollabBoard] UI layer initialized');

    let pendingAction = null; // 'join' or 'create'
    let pendingRoomCode = null;
    let roomMembers = [];

    // --- Modal Logic ---

    function showError(message) {
        DOM.modalError.textContent = message;
    }

    function clearError() {
        DOM.modalError.textContent = '';
    }

    function setModalLoading(isLoading) {
        DOM.modalUsername.disabled = isLoading;
        DOM.modalRoomCode.disabled = isLoading;
        DOM.modalJoinBtn.disabled = isLoading;
        DOM.modalCreateBtn.disabled = isLoading;
        DOM.modalJoinBtn.textContent = isLoading ? 'Connecting...' : 'Join Room';
        DOM.modalCreateBtn.textContent = isLoading ? 'Connecting...' : 'Create Room';
    }

    function switchModalTab(tab) {
        clearError();
        if (tab === 'create') {
            DOM.modalTabCreate.classList.add('active');
            DOM.modalTabJoin.classList.remove('active');
            DOM.modalFieldRoomCode.style.display = 'none';
            DOM.modalCreateBtn.style.display = 'block';
            DOM.modalJoinBtn.style.display = 'none';
            setTimeout(() => DOM.modalUsername.focus(), 50);
        } else {
            DOM.modalTabJoin.classList.add('active');
            DOM.modalTabCreate.classList.remove('active');
            DOM.modalFieldRoomCode.style.display = 'flex';
            DOM.modalJoinBtn.style.display = 'block';
            DOM.modalCreateBtn.style.display = 'none';
            setTimeout(() => DOM.modalRoomCode.focus(), 50);
        }
    }

    if (DOM.modalTabCreate && DOM.modalTabJoin) {
        DOM.modalTabCreate.addEventListener('click', () => switchModalTab('create'));
        DOM.modalTabJoin.addEventListener('click', () => switchModalTab('join'));
    }

    function handleConnect(action) {
        const username = DOM.modalUsername.value.trim();
        let roomCode = DOM.modalRoomCode.value.trim().toUpperCase();

        clearError();

        if (!username) {
            showError('Please enter a display name.');
            DOM.modalUsername.focus();
            return;
        }

        if (action === 'join' && !roomCode) {
            showError('Please enter a room code to join.');
            DOM.modalRoomCode.focus();
            return;
        }

        pendingAction = action;
        pendingRoomCode = roomCode;

        setModalLoading(true);

        // If we are already identified, just proceed directly (e.g. reconnect scenario later)
        if (network.isIdentified) {
            executePendingAction();
        } else {
            AppState.username = username;
            network.connect(username);
        }
    }

    function executePendingAction() {
        if (pendingAction === 'create') {
            network.send({ type: 'create_room' });
        } else if (pendingAction === 'join') {
            network.send({ type: 'join_room', room_id: pendingRoomCode });
        }
    }

    DOM.modalJoinBtn.addEventListener('click', () => handleConnect('join'));
    DOM.modalCreateBtn.addEventListener('click', () => handleConnect('create'));

    // Allow Enter key to submit
    DOM.modalUsername.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const isJoin = DOM.modalTabJoin.classList.contains('active');
            handleConnect(isJoin ? 'join' : 'create');
        }
    });
    DOM.modalRoomCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleConnect('join');
    });

    // --- Network Listeners ---

    network.on('hello_ack', () => {
        if (pendingAction) {
            executePendingAction();
        }
    });

    network.on('error', (data) => {
        // If error happens during connect/join phase
        if (pendingAction) {
            setModalLoading(false);
            showError(`Error: ${data.message}`);
        }
    });

    network.on('join_rejected', (data) => {
        setModalLoading(false);
        const reasonStr = data.reason === 'room_not_found' ? 'Room not found.' : 
                          data.reason === 'room_full' ? 'Room is full (max 8 users).' : data.reason;
        showError(`Could not join: ${reasonStr}`);
    });

    network.on('room_created', (data) => {
        finishJoinOrCreate(data.room_id);
        // We are the only participant
        renderParticipants([{ user_id: AppState.userId, username: AppState.username }]);
    });

    network.on('join_ack', (data) => {
        finishJoinOrCreate(data.room_id);
        renderParticipants(data.members);
    });

    network.on('reconnect_failed', () => {
        // Return to modal if we fail to reconnect
        if (AppState.roomId) {
            DOM.roomModal.setAttribute('aria-hidden', 'false');
            showError('Connection lost completely. Please rejoin.');
        }
    });

    function finishJoinOrCreate(roomId) {
        setModalLoading(false);
        pendingAction = null;
        pendingRoomCode = null;

        AppState.roomId = roomId;
        network.setRoomId(roomId); // inform network layer for auto-rejoin logic

        // Hide modal
        DOM.roomModal.setAttribute('aria-hidden', 'true');

        // Update toolbar and status bar
        DOM.toolbarRoomName.textContent = roomId;
        DOM.statusRoom.textContent = `Room: ${roomId}`;
        
        console.log(`[CollabBoard] Entered room ${roomId}`);
    }

    // --- Sidebar & Participant Logic ---

    function renderParticipants(members) {
        roomMembers = members;
        _renderParticipants();
    }

    function _renderParticipants() {
        // Render Sidebar
        DOM.participantList.innerHTML = '';
        roomMembers.forEach(m => {
            const li = document.createElement('li');
            li.className = 'sidebar__list-item';
            li.dataset.userId = m.user_id;

            const avatar = document.createElement('div');
            avatar.className = 'sidebar__list-avatar';
            const hue = Array.from(m.username).reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
            avatar.style.backgroundColor = `hsl(${hue}, 60%, 45%)`;
            avatar.textContent = m.username.substring(0, 2).toUpperCase();

            const nameSpan = document.createElement('span');
            nameSpan.className = 'sidebar__list-name';
            nameSpan.textContent = m.username + (m.user_id === AppState.userId ? ' (You)' : '');

            li.appendChild(avatar);
            li.appendChild(nameSpan);
            DOM.participantList.appendChild(li);
        });

        // Render Toolbar Avatars (up to 4)
        DOM.participants.innerHTML = '';
        roomMembers.slice(0, 4).forEach(m => {
            const avatar = document.createElement('div');
            avatar.className = 'toolbar__avatar';
            const hue = Array.from(m.username).reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
            avatar.style.backgroundColor = `hsl(${hue}, 60%, 45%)`;
            avatar.textContent = m.username.substring(0, 2).toUpperCase();
            avatar.title = m.username;
            DOM.participants.appendChild(avatar);
        });

        // Add "+N" if more than 4
        if (roomMembers.length > 4) {
            const extra = document.createElement('div');
            extra.className = 'toolbar__avatar';
            extra.style.backgroundColor = 'var(--color-surface-hover)';
            extra.style.color = 'var(--color-text-primary)';
            extra.textContent = `+${roomMembers.length - 4}`;
            DOM.participants.appendChild(extra);
        }

        DOM.statusUsers.textContent = `${roomMembers.length} user${roomMembers.length === 1 ? '' : 's'}`;
    }

    network.on('user_joined', (data) => {
        console.log(`[CollabBoard] User joined: ${data.username}`);
        // Avoid duplicate additions
        if (!roomMembers.find(m => m.user_id === data.user_id)) {
            roomMembers.push({ user_id: data.user_id, username: data.username });
            _renderParticipants();
        }
    });

    network.on('user_left', (data) => {
        console.log(`[CollabBoard] User left: ${data.username}`);
        roomMembers = roomMembers.filter(m => m.user_id !== data.user_id);
        _renderParticipants();
    });

    // --- Easter Egg Logic ---
    let consecutiveClicks = 0;
    let easterEggLevel = 0;
    let lastClickTime = 0;
    const menuBtn = document.getElementById('toolbar-menu-btn');
    const toolbar = document.getElementById('toolbar');
    const easterEggModal = document.getElementById('easter-egg-modal');
    const easterEggCloseBtn = document.getElementById('easter-egg-close-btn');

    if (menuBtn) {
        menuBtn.addEventListener('click', () => {
            const now = performance.now();
            if (now - lastClickTime < 500) {
                consecutiveClicks++;
            } else {
                consecutiveClicks = 1;
            }
            lastClickTime = now;

            if (consecutiveClicks >= 10) {
                consecutiveClicks = 0;
                easterEggLevel++;

                if (easterEggLevel === 1 || easterEggLevel === 2) {
                    if (toolbar) {
                        toolbar.classList.add('shake-active');
                        setTimeout(() => {
                            toolbar.classList.remove('shake-active');
                        }, 400);
                    }
                } else if (easterEggLevel >= 3) {
                    if (easterEggModal) {
                        easterEggModal.setAttribute('aria-hidden', 'false');
                    }
                    easterEggLevel = 0; // Reset for next time
                }
            }
        });
    }

    if (easterEggCloseBtn && easterEggModal) {
        easterEggCloseBtn.addEventListener('click', () => {
            easterEggModal.setAttribute('aria-hidden', 'true');
        });
    }

})();
