// =============================================================================
// CollabBoard — Main JS Entry Point
// =============================================================================
// Owner : M2 (Frontend Engineer)
// Sprint: Day 1–2
//
// Initializes the application shell, binds core DOM elements, wires up
// toolbar interactions (tool switching, color picker sync, sidebar toggle),
// and integrates the NetworkManager for WebSocket connectivity.
//
// Day 2 additions:
//   - NetworkManager integration (auto-connect, status bar updates)
//   - AppState expanded with username, userId, roomId
//   - Connection state reflected in status bar indicator
//
// Reference:
//   - IMPLEMENTATION_PLAN.md §F1
//   - SPECIFICATION.md §6.2
//   - WEBSOCKET_PROTOCOL_EXTENSION.md §1, §9
// =============================================================================

'use strict';

/**
 * CollabBoard — Application State
 *
 * Central state object for the entire frontend application.
 * Expanded on Day 2 with network-related fields.
 */
const AppState = window.AppState = {
    /** @type {'select'|'pencil'|'text'|'rectangle'|'circle'|'line'|'arrow'|'heart'|'image'} */
    activeTool: 'select',

    /** Current stroke colour (hex) */
    strokeColor: '#1a1a2e',

    /** Current stroke width (px) */
    strokeWidth: 4,

    /** Current theme */
    theme: 'light',

    /** Whether the sidebar is open */
    sidebarOpen: false,

    /** Stroke mode */
    strokeEnabled: true,
    strokeColor: '#1a1a2e',

    /** Fill mode */
    fillEnabled: false,
    fillColor: '#5b5fc7',

    /** Text mode */
    fontSize: 24,

    // -- Day 2: Network state ------------------------------------------------

    /** Display name used for hello handshake */
    username: null,

    /** UUID assigned by server on hello_ack */
    userId: null,

    /** Current room ID (null = not in a room) */
    roomId: null,

    // -- Day 8: Cursor Chat state --------------------------------------------

    /** Last known logical coordinates of the local cursor */
    lastKnownCursor: { x: 0, y: 0 },

    /** Whether the cursor chat input is currently open */
    isChatInputOpen: false,

    /** Reference to the local chat input wrapper DOM element */
    activeChatInput: null,

    /** Reference to the local chat bubble DOM element */
    activeLocalBubble: null,

    /** Active remote chat bubbles (mapped by user ID) */
    activeRemoteBubbles: {},
};

// ---------------------------------------------------------------------------
// DOM References
// ---------------------------------------------------------------------------
const DOM = {
    // Core containers
    app: document.getElementById('app'),
    canvasContainer: document.getElementById('canvas-container'),
    canvas: document.getElementById('canvas'),
    cursorOverlay: document.getElementById('cursor-overlay'),

    // Toolbar
    toolbar: document.getElementById('toolbar'),
    toolbarRoomName: document.getElementById('toolbar-room-name'),
    toolButtons: document.querySelectorAll('.toolbar__tool'),
    colorInput: document.getElementById('tool-color'),
    colorSwatch: document.getElementById('tool-color-swatch'),
    strokeWidthSelect: document.getElementById('tool-stroke-width'),
    sidebarToggle: document.getElementById('toolbar-sidebar-toggle'),
    menuBtn: document.getElementById('toolbar-menu-btn'),
    moreBtn: document.getElementById('toolbar-more-btn'),
    moreOptionsDropdown: document.getElementById('more-options-dropdown'),
    exportBtn: document.getElementById('menu-export-collab'),
    importBtn: document.getElementById('menu-import-collab'),
    importFile: document.getElementById('import-file'),
    toolShapesBtn: document.getElementById('tool-shapes'),
    shapesPopover: document.getElementById('shapes-popover'),
    shapesIcon: document.getElementById('tool-shapes-icon'),
    strokeToggleBtn: document.getElementById('tool-stroke-toggle'),
    strokeColorInput: document.getElementById('tool-stroke-color'),
    strokeColorSwatch: document.getElementById('tool-stroke-swatch'),
    strokeControls: document.getElementById('stroke-controls'),
    strokeSeparator: document.getElementById('stroke-separator'),
    fillToggleBtn: document.getElementById('tool-fill-toggle'),
    fillColorInput: document.getElementById('tool-fill-color'),
    fillColorSwatch: document.getElementById('tool-fill-swatch'),
    fillControls: document.getElementById('fill-controls'),
    fillSeparator: document.getElementById('fill-separator'),
    fontSizeSelect: document.getElementById('tool-font-size'),
    participants: document.getElementById('toolbar-participants'),
    pngExportBtn: document.getElementById('toolbar-export-btn'),
    toast: document.getElementById('toast'),

    // Sidebar
    sidebar: document.getElementById('sidebar'),
    sidebarCloseBtn: document.getElementById('sidebar-close-btn'),
    participantList: document.getElementById('sidebar-participant-list'),

    // Status bar
    statusBar: document.getElementById('status-bar'),
    statusConnection: document.getElementById('status-connection'),
    statusRoom: document.getElementById('status-room'),
    statusSave: document.getElementById('status-save'),
    statusUsers: document.getElementById('status-users'),

    // Modal
    roomModal: document.getElementById('room-modal'),
    modalTabCreate: document.getElementById('modal-tab-create'),
    modalTabJoin: document.getElementById('modal-tab-join'),
    modalUsername: document.getElementById('modal-username'),
    modalRoomCode: document.getElementById('modal-room-code'),
    modalFieldRoomCode: document.getElementById('modal-field-room-code'),
    modalError: document.getElementById('modal-error'),
    modalJoinBtn: document.getElementById('modal-join-btn'),
    modalCreateBtn: document.getElementById('modal-create-btn'),
    leaveBtn: document.getElementById('menu-leave-room'),
    leaveModal: document.getElementById('leave-modal'),
    leaveCancelBtn: document.getElementById('leave-cancel-btn'),
    leaveProceedBtn: document.getElementById('leave-proceed-btn'),
};

// ---------------------------------------------------------------------------
// Tool Switching
// ---------------------------------------------------------------------------
function setActiveTool(toolName) {
    AppState.activeTool = toolName;

    if (toolName !== 'select' && window.CollabCanvas) {
        window.CollabCanvas.clearSelection();
    }

    DOM.toolButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === toolName);
    });

    // Update canvas cursor style based on tool
    const cursorMap = {
        select: 'default',
        pencil: 'crosshair',
        text: 'text',
        rectangle: 'crosshair',
        circle: 'crosshair',
        line: 'crosshair',
        arrow: 'crosshair',
        heart: 'crosshair',
        image: 'pointer',
    };
    DOM.canvas.style.cursor = cursorMap[toolName] || 'default';

    // Hide specific UI elements based on tool requirements
    const noFillTools = ['pencil', 'line', 'arrow', 'text'];
    const noStrokeToggleTools = ['pencil', 'line', 'arrow', 'text'];
    const noColorTools = ['image']; // removed 'select' so properties can be edited

    if (noColorTools.includes(toolName)) {
        if (DOM.strokeControls) DOM.strokeControls.style.display = 'none';
        if (DOM.strokeSeparator) DOM.strokeSeparator.style.display = 'none';
        if (DOM.fillControls) DOM.fillControls.style.display = 'none';
        if (DOM.fillSeparator) DOM.fillSeparator.style.display = 'none';
        if (DOM.strokeWidthSelect) DOM.strokeWidthSelect.style.display = 'none';
    } else {
        if (DOM.strokeControls) DOM.strokeControls.style.display = 'flex';
        if (DOM.strokeSeparator) DOM.strokeSeparator.style.display = 'block';
        if (DOM.strokeWidthSelect) {
            DOM.strokeWidthSelect.style.display = (toolName === 'text') ? 'none' : 'inline-block';
        }
        
        if (DOM.fontSizeSelect) {
            DOM.fontSizeSelect.style.display = (toolName === 'text') ? 'inline-block' : 'none';
        }
        
        if (DOM.strokeToggleBtn) {
            DOM.strokeToggleBtn.style.display = noStrokeToggleTools.includes(toolName) ? 'none' : 'flex';
        }

        if (DOM.fillControls) DOM.fillControls.style.display = noFillTools.includes(toolName) ? 'none' : 'flex';
        if (DOM.fillSeparator) DOM.fillSeparator.style.display = noFillTools.includes(toolName) ? 'none' : 'block';
    }

    console.log(`[CollabBoard] Active tool: ${toolName}`);
}

DOM.toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        if (tool === 'image') {
            const uploadInput = document.getElementById('image-upload-input');
            if (uploadInput) uploadInput.click();
            return;
        }
        setActiveTool(tool);
    });
});

// ---------------------------------------------------------------------------
// Stroke & Fill Controls
// ---------------------------------------------------------------------------

function syncColors(changedType) {
    DOM.strokeColorSwatch.style.background = DOM.strokeColorInput.value;
    AppState.strokeColor = DOM.strokeColorInput.value;
    
    DOM.fillColorSwatch.style.background = DOM.fillColorInput.value;
    AppState.fillColor = DOM.fillColorInput.value;

    // Phase 2, Sprint 3: Live update selected object
    if (window.CollabCanvas && window.CollabCanvas.selectedObjectId) {
        const selectedObj = window.CollabCanvas.getSelectedObject();
        if (selectedObj && changedType) {
            const oldSnapshot = JSON.parse(JSON.stringify(selectedObj));
            const changes = {};

            if (changedType === 'stroke') {
                changes.color = AppState.strokeColor;
                selectedObj.color = AppState.strokeColor;
            } else if (changedType === 'fill') {
                changes.properties = { ...selectedObj.properties, fill_color: AppState.fillColor };
                selectedObj.properties.fill_color = AppState.fillColor;
            }

            if (window.network && window.network.isIdentified) {
                const modifyOp = {
                    type: 'op',
                    op: 'modify',
                    obj_id: selectedObj.obj_id,
                    changes: changes
                };
                window.network.send(modifyOp);

                if (window.UndoRedoManager) {
                    window.UndoRedoManager.pushAction({
                        type: 'op',
                        op: 'modify',
                        obj_id: selectedObj.obj_id,
                        changes: changes,
                        old_values: changedType === 'stroke' 
                            ? { color: oldSnapshot.color }
                            : { properties: { fill_color: oldSnapshot.properties.fill_color } }
                    });
                }
            }
        }
    }
}

DOM.strokeColorInput.addEventListener('input', () => syncColors('stroke'));
DOM.fillColorInput.addEventListener('input', () => syncColors('fill'));

DOM.strokeToggleBtn.addEventListener('click', () => {
    AppState.strokeEnabled = !AppState.strokeEnabled;
    DOM.strokeToggleBtn.classList.toggle('active', AppState.strokeEnabled);

    if (window.CollabCanvas && window.CollabCanvas.selectedObjectId) {
        const selectedObj = window.CollabCanvas.getSelectedObject();
        if (selectedObj && selectedObj.obj_type !== 'text' && selectedObj.obj_type !== 'image') {
            const oldSnapshot = JSON.parse(JSON.stringify(selectedObj));
            const newStrokeWidth = AppState.strokeEnabled ? AppState.strokeWidth : 0;
            
            selectedObj.stroke_width = newStrokeWidth;
            
            if (window.network && window.network.isIdentified) {
                const modifyOp = {
                    type: 'op',
                    op: 'modify',
                    obj_id: selectedObj.obj_id,
                    changes: { stroke_width: newStrokeWidth }
                };
                window.network.send(modifyOp);
                
                if (window.UndoRedoManager) {
                    window.UndoRedoManager.pushAction({
                        type: 'op',
                        op: 'modify',
                        obj_id: selectedObj.obj_id,
                        changes: { stroke_width: newStrokeWidth },
                        old_values: { stroke_width: oldSnapshot.stroke_width }
                    });
                }
            }
        }
    }
});

DOM.fillToggleBtn.addEventListener('click', () => {
    AppState.fillEnabled = !AppState.fillEnabled;
    DOM.fillToggleBtn.classList.toggle('active', AppState.fillEnabled);

    if (window.CollabCanvas && window.CollabCanvas.selectedObjectId) {
        const selectedObj = window.CollabCanvas.getSelectedObject();
        if (selectedObj && ['rectangle', 'circle', 'heart'].includes(selectedObj.obj_type)) {
            const oldSnapshot = JSON.parse(JSON.stringify(selectedObj));
            const newFillColor = AppState.fillEnabled ? AppState.fillColor : null;
            
            selectedObj.properties.fill_color = newFillColor;
            
            if (window.network && window.network.isIdentified) {
                const modifyOp = {
                    type: 'op',
                    op: 'modify',
                    obj_id: selectedObj.obj_id,
                    changes: { properties: selectedObj.properties }
                };
                window.network.send(modifyOp);
                
                if (window.UndoRedoManager) {
                    window.UndoRedoManager.pushAction({
                        type: 'op',
                        op: 'modify',
                        obj_id: selectedObj.obj_id,
                        changes: { properties: selectedObj.properties },
                        old_values: { properties: oldSnapshot.properties }
                    });
                }
            }
        }
    }
});

// Initialize on load
syncColors();


// ---------------------------------------------------------------------------
// Tool Settings
// ---------------------------------------------------------------------------
DOM.strokeWidthSelect.addEventListener('change', (e) => {
    AppState.strokeWidth = parseInt(e.target.value, 10);
    console.log(`[CollabBoard] Stroke width: ${AppState.strokeWidth}px`);

    // Phase 2, Sprint 3: Update selected object
    if (window.CollabCanvas && window.CollabCanvas.selectedObjectId) {
        const selectedObj = window.CollabCanvas.getSelectedObject();
        if (selectedObj) {
            const oldWidth = selectedObj.stroke_width;
            selectedObj.stroke_width = AppState.strokeWidth;
            
            if (window.network && window.network.isIdentified) {
                const modifyOp = {
                    type: 'op',
                    op: 'modify',
                    obj_id: selectedObj.obj_id,
                    changes: { stroke_width: AppState.strokeWidth }
                };
                window.network.send(modifyOp);

                if (window.UndoRedoManager) {
                    window.UndoRedoManager.pushAction({
                        type: 'op',
                        op: 'modify',
                        obj_id: selectedObj.obj_id,
                        changes: { stroke_width: AppState.strokeWidth },
                        old_values: { stroke_width: oldWidth }
                    });
                }
            }
        }
    }
});

DOM.fontSizeSelect.addEventListener('change', (e) => {
    AppState.fontSize = parseInt(e.target.value, 10);
    console.log(`[CollabBoard] Font size: ${AppState.fontSize}px`);

    // Phase 2, Sprint 3: Update selected text object
    if (window.CollabCanvas && window.CollabCanvas.selectedObjectId) {
        const selectedObj = window.CollabCanvas.getSelectedObject();
        if (selectedObj && selectedObj.obj_type === 'text') {
            const oldSize = selectedObj.properties.font_size;
            selectedObj.properties.font_size = AppState.fontSize;
            
            if (window.network && window.network.isIdentified) {
                const modifyOp = {
                    type: 'op',
                    op: 'modify',
                    obj_id: selectedObj.obj_id,
                    changes: { properties: { font_size: AppState.fontSize } }
                };
                window.network.send(modifyOp);

                if (window.UndoRedoManager) {
                    window.UndoRedoManager.pushAction({
                        type: 'op',
                        op: 'modify',
                        obj_id: selectedObj.obj_id,
                        changes: { properties: { font_size: AppState.fontSize } },
                        old_values: { properties: { font_size: oldSize } }
                    });
                }
            }
        }
    }
});

// ---------------------------------------------------------------------------
// Sidebar Toggle
// ---------------------------------------------------------------------------
function toggleSidebar(forceState) {
    const shouldOpen = typeof forceState === 'boolean'
        ? forceState
        : !AppState.sidebarOpen;

    AppState.sidebarOpen = shouldOpen;
    DOM.sidebar.classList.toggle('open', shouldOpen);
    DOM.sidebar.setAttribute('aria-hidden', String(!shouldOpen));
}

DOM.sidebarToggle.addEventListener('click', () => toggleSidebar());
DOM.sidebarCloseBtn.addEventListener('click', () => toggleSidebar(false));

// ---------------------------------------------------------------------------
// Theme Toggle (Ctrl+Shift+D for dev convenience)
// ---------------------------------------------------------------------------
function setTheme(theme) {
    AppState.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    console.log(`[CollabBoard] Theme: ${theme}`);
}

document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setTheme(AppState.theme === 'light' ? 'dark' : 'light');
    }
});

// ---------------------------------------------------------------------------
// Cursor Chat & Undo/Redo & Keyboard Shortcuts
// ---------------------------------------------------------------------------

/**
 * Renders a cursor chat bubble that auto-dismisses after 4 seconds.
 * @param {string} userId - UUID of the user
 * @param {string} username - Name to display
 * @param {number} logicalX - 1920x1080 coordinate
 * @param {number} logicalY - 1920x1080 coordinate
 * @param {string} message - Chat text
 */
function renderCursorChatBubble(userId, username, logicalX, logicalY, message) {
    if (userId === AppState.userId && !message) {
        return;
    }

    let bubble;
    const isLocal = userId === AppState.userId;

    if (isLocal) {
        bubble = AppState.activeLocalBubble;
    } else {
        bubble = AppState.activeRemoteBubbles[userId];
    }

    if (!message) {
        if (bubble && bubble.parentNode && !bubble._isFadingOut) {
            // Clear the inactivity timer so it doesn't double-fire
            if (bubble._dismissTimer) clearTimeout(bubble._dismissTimer);
            bubble._isFadingOut = true;
            bubble._fadeOutAnim = bubble.animate(
                [{ opacity: 1 }, { opacity: 0 }],
                { duration: 800, easing: 'ease-out' }
            );
            bubble._fadeOutAnim.onfinish = () => {
                if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
                if (isLocal) AppState.activeLocalBubble = null;
                else delete AppState.activeRemoteBubbles[userId];
            };
        }
        return;
    }

    if (!bubble) {
        const rect = DOM.canvasContainer.getBoundingClientRect();
        const scaleX = rect.width / 1920;
        const scaleY = rect.height / 1080;

        const screenX = logicalX * scaleX;
        const screenY = logicalY * scaleY;

        bubble = document.createElement('div');
        bubble.className = 'cursor-chat-bubble';
        bubble.style.left = `${screenX}px`;
        bubble.style.top = `${screenY - 10}px`;
        bubble.style.transform = 'translate(10px, -100%)';

        const hue = Array.from(username).reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
        bubble.style.backgroundColor = `hsl(${hue}, 70%, 40%)`;

        const msgEl = document.createElement('div');
        msgEl.className = 'cursor-chat-bubble__message';

        bubble.appendChild(msgEl);

        let attachedToRemote = false;
        if (!isLocal && window.CursorManager) {
            const remoteCursor = window.CursorManager.cursors.get(userId);
            if (remoteCursor && remoteCursor.element) {
                bubble.style.left = '0px';
                bubble.style.top = '-10px';
                remoteCursor.element.appendChild(bubble);
                attachedToRemote = true;
            }
        }

        if (!attachedToRemote) {
            DOM.cursorOverlay.appendChild(bubble);
        }

        if (isLocal) {
            AppState.activeLocalBubble = bubble;
        } else {
            AppState.activeRemoteBubbles[userId] = bubble;
        }
    }

    if (bubble._isFadingOut) {
        if (bubble._fadeOutAnim) bubble._fadeOutAnim.cancel();
        bubble._isFadingOut = false;
        bubble.style.opacity = '1';
    }

    const msgEl = bubble.querySelector('.cursor-chat-bubble__message');
    if (msgEl) msgEl.textContent = message;

    // Reset the inactivity timer on every incoming message.
    // Fade out only triggers after 4s of silence from the sender.
    if (bubble._dismissTimer) clearTimeout(bubble._dismissTimer);
    bubble._dismissTimer = setTimeout(() => {
        if (bubble.parentNode && !bubble._isFadingOut) {
            bubble._isFadingOut = true;
            bubble._fadeOutAnim = bubble.animate(
                [{ opacity: 1 }, { opacity: 0 }],
                { duration: 800, easing: 'ease-out' }
            );
            bubble._fadeOutAnim.onfinish = () => {
                if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
                if (isLocal) AppState.activeLocalBubble = null;
                else delete AppState.activeRemoteBubbles[userId];
            };
        }
    }, 4000);
}

/**
 * Opens the floating cursor chat input at the last known cursor position.
 */
function openCursorChatInput() {
    if (AppState.isChatInputOpen) return;
    AppState.isChatInputOpen = true;

    // Convert logical coordinates to screen pixels
    const rect = DOM.canvasContainer.getBoundingClientRect();
    const scaleX = rect.width / 1920;
    const scaleY = rect.height / 1080;
    const screenX = AppState.lastKnownCursor.x * scaleX;
    const screenY = AppState.lastKnownCursor.y * scaleY;

    // Create the input wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'cursor-chat-input-wrapper';
    wrapper.style.left = `${screenX + 15}px`; // Offset slightly from the exact point
    wrapper.style.top = `${screenY - 15}px`;

    const slashBadge = document.createElement('div');
    slashBadge.className = 'cursor-chat-input-slash';
    slashBadge.textContent = '/';

    const input = document.createElement('textarea');
    input.className = 'cursor-chat-input';
    input.placeholder = 'Say something...';
    input.maxLength = 500;
    input.rows = 1;

    wrapper.appendChild(slashBadge);
    wrapper.appendChild(input);
    DOM.cursorOverlay.appendChild(wrapper);
    AppState.activeChatInput = wrapper;

    // Focus the input immediately
    input.focus();

    // -- Auto-dismiss on inactivity --
    let inactivityTimeout;
    function resetInactivityTimeout() {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = setTimeout(() => {
            closeCursorChatInput(true);
        }, 4000);
    }

    // Start the timer
    resetInactivityTimeout();

    const sendCurrentText = (isFinal = false) => {
        if (!network.isIdentified || !AppState.roomId) return;
        const message = input.value.trim();
        // Send to server
        network.send({
            type: 'cursor_chat',
            x: AppState.lastKnownCursor.x,
            y: AppState.lastKnownCursor.y,
            message: message
        });

        // Show optimistic local bubble ONLY on final submit (e.g. Enter)
        if (message) {
            if (isFinal) {
                renderCursorChatBubble(
                    AppState.userId,
                    AppState.username,
                    AppState.lastKnownCursor.x,
                    AppState.lastKnownCursor.y,
                    message
                );
            }
        } else {
            // Remove local bubble if empty
            if (AppState.activeLocalBubble && AppState.activeLocalBubble.parentNode) {
                AppState.activeLocalBubble.parentNode.removeChild(AppState.activeLocalBubble);
                AppState.activeLocalBubble = null;
            }
        }
    };

    let debounceTimer;

    // Handle real-time typing
    input.addEventListener('input', () => {
        // Auto-resize the textarea
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 150) + 'px';

        resetInactivityTimeout();

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            sendCurrentText(false);
        }, 50); // 50ms throttle
    });

    // Handle input keys
    input.addEventListener('keydown', (e) => {
        // Prevent event from bubbling up to global hotkeys
        e.stopPropagation();

        // User interacted, reset the 4s auto-dismiss timer
        resetInactivityTimeout();

        if (e.key === 'Escape') {
            input.value = '';
            closeCursorChatInput(true);
        }
    });

    // Close if user clicks outside
    const outsideClickListener = (e) => {
        if (!wrapper.contains(e.target)) {
            closeCursorChatInput(true);
            document.removeEventListener('mousedown', outsideClickListener);
        }
    };

    // Defer attaching the outside click listener to avoid triggering on the current event
    setTimeout(() => {
        document.addEventListener('mousedown', outsideClickListener);
    }, 0);

    function closeCursorChatInput(isCancel = true) {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);

        if (wrapper.parentNode) {
            const fadeOut = wrapper.animate([
                { opacity: 1 },
                { opacity: 0 }
            ], {
                duration: 250,
                easing: 'ease-out'
            });

            if (isCancel && network.isIdentified && AppState.roomId) {
                // Send an empty message to sync the remote bubble's fade out
                network.send({
                    type: 'cursor_chat',
                    x: AppState.lastKnownCursor.x,
                    y: AppState.lastKnownCursor.y,
                    message: ''
                });
            }

            fadeOut.onfinish = () => {
                if (wrapper.parentNode) {
                    wrapper.parentNode.removeChild(wrapper);
                }
            };
        }
        AppState.isChatInputOpen = false;
        AppState.activeChatInput = null;
        // Refocus canvas or app so global hotkeys work again
        DOM.canvas.focus();
    }
}

// Track local cursor position for cursor chat spawning and following
DOM.canvas.addEventListener('mousemove', (e) => {
    // Convert to logical coordinates
    const rect = DOM.canvas.getBoundingClientRect();
    const scaleX = 1920 / rect.width;
    const scaleY = 1080 / rect.height;
    AppState.lastKnownCursor = {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY)
    };

    // Update positioning for local floating elements
    // We can use the raw client offsets relative to the canvas
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (AppState.activeLocalBubble) {
        AppState.activeLocalBubble.style.left = `${screenX}px`;
        AppState.activeLocalBubble.style.top = `${screenY - 10}px`;
    }
    if (AppState.activeChatInput) {
        AppState.activeChatInput.style.left = `${screenX + 15}px`;
        AppState.activeChatInput.style.top = `${screenY - 15}px`;
    }
});

document.addEventListener('keydown', (e) => {
    // -- Day 8: Undo/Redo Bindings --
    if (e.ctrlKey || e.metaKey) {
                if (e.key.toLowerCase() === 'z') {
            if (e.shiftKey) {
                // Ctrl+Shift+Z -> Redo
                e.preventDefault();
                window.UndoRedoManager?.redo();
                return;
            } else {
                // Ctrl+Z -> Undo
                e.preventDefault();
                window.UndoRedoManager?.undo();
                return;
            }
        }
        if (e.key.toLowerCase() === 'y') {
            // Ctrl+Y -> Redo
            e.preventDefault();
            window.UndoRedoManager?.redo();
            return;
        }
    }

    // Don't capture standard hotkeys when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }

    // Modifiers mean it's likely a browser shortcut, let it pass
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // -- Day 8: Cursor Chat trigger --
    if (e.key === '/') {
        e.preventDefault();
        openCursorChatInput();
        return;
    }

    // -- Tool Hotkeys --

    const keyMap = {
        'v': 'select',
        'p': 'pencil',
        't': 'text',
        'i': 'image',
    };

    const tool = keyMap[e.key.toLowerCase()];
    if (tool) {
        e.preventDefault();
        setActiveTool(tool);
    } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        selectActiveShape();
    }

    // 'u' toggles sidebar
    if (e.key.toLowerCase() === 'u') {
        e.preventDefault();
        toggleSidebar();
    }

    // -- Phase 2, Sprint 3: Delete Object --
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (window.CollabCanvas && window.CollabCanvas.selectedObjectId) {
            e.preventDefault();
            const selectedObj = window.CollabCanvas.getSelectedObject();
            if (selectedObj) {
                const snapshot = JSON.parse(JSON.stringify(selectedObj));
                const objId = selectedObj.obj_id;

                // Send delete operation
                if (window.network && window.network.isIdentified) {
                    const deleteOp = {
                        type: 'op',
                        op: 'delete',
                        obj_id: objId
                    };
                    window.network.send(deleteOp);

                    if (window.UndoRedoManager) {
                        window.UndoRedoManager.pushAction({
                            type: 'op',
                            op: 'add',
                            object: snapshot
                        });
                    }
                }

                // Remove optimistically and clear selection
                window.CollabCanvas.removeOptimisticObject(objId);
                window.CollabCanvas.clearSelection();
            }
        }
    }
});

// ---------------------------------------------------------------------------
// Phase 2, Sprint 4: Clipboard Paste Handler
// ---------------------------------------------------------------------------
document.addEventListener('paste', async (e) => {
    // 1. Prevent interception if user is typing
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
    }

    // 2. Check if we are in a room
    if (!window.AppState.roomId) return;

    // 3. Find the image item in clipboard
    const items = e.clipboardData.items;
    let imageFile = null;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
            imageFile = items[i].getAsFile();
            break;
        }
    }

    if (!imageFile) return;

    e.preventDefault();

    try {
        const MAX_WIDTH = 600;
        const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
        
        // Read file to data URL
        const reader = new FileReader();
        const base64Data = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(imageFile);
        });

        // Load into an Image object
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = base64Data;
        });

        let finalBase64 = base64Data;
        let finalWidth = img.naturalWidth;
        let finalHeight = img.naturalHeight;

        // Scale if wider than 600px
        if (finalWidth > MAX_WIDTH) {
            const scale = MAX_WIDTH / finalWidth;
            finalWidth = MAX_WIDTH;
            finalHeight = Math.round(finalHeight * scale);

            const offscreen = document.createElement('canvas');
            offscreen.width = finalWidth;
            offscreen.height = finalHeight;
            const ctx = offscreen.getContext('2d');
            ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
            finalBase64 = offscreen.toDataURL('image/jpeg', 0.8);
        } else if (imageFile.size > MAX_FILE_SIZE) {
            // Even if not wider than 600px, if it's over 2MB, try to compress
            const offscreen = document.createElement('canvas');
            offscreen.width = finalWidth;
            offscreen.height = finalHeight;
            const ctx = offscreen.getContext('2d');
            ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
            finalBase64 = offscreen.toDataURL('image/jpeg', 0.8);
        }

        // Final check for 2MB limit (approx base64 string length)
        if (finalBase64.length > MAX_FILE_SIZE * 1.37) {
            showToast('Pasted image is too large (over 2MB).');
            return;
        }

        // 4. Compute placement position (center of 1920x1080 minus half dimensions)
        const placementX = Math.round(960 - finalWidth / 2);
        const placementY = Math.round(540 - finalHeight / 2);

        // Generate temporary ID
        const generateUUID = () => {
            try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        };
        const tempId = 'temp-' + generateUUID();

        // 5. Construct op: add payload
        const addOp = {
            type: 'op',
            op: 'add',
            object: {
                obj_type: 'image',
                z_index: window.CollabCanvas.objects.size,
                color: '#000000',
                stroke_width: 0,
                properties: {
                    x: placementX,
                    y: placementY,
                    width: finalWidth,
                    height: finalHeight,
                    image_data: finalBase64,
                    base64: finalBase64, // Local & broadcast optimization
                    original_filename: "clipboard_paste.png"
                },
                obj_id: tempId,
                created_by: window.AppState.userId || 'local',
                created_at: new Date().toISOString()
            }
        };

        // 6. Optimistic update and dispatch
        window.CollabCanvas.addOptimisticObject(addOp.object);

        if (window.network && window.network.isIdentified) {
            window.network.send(addOp);
            if (window.UndoRedoManager) {
                window.UndoRedoManager.pushAction(addOp);
            }
        }

        // 7. Auto-select the newly pasted image
        if (typeof window.CollabCanvas.selectObject === 'function') {
            setActiveTool('select');
            window.CollabCanvas.selectObject(tempId);
            
            // Sync UI state for selection
            const fillToggleBtn = document.getElementById('tool-fill-toggle');
            const strokeToggleBtn = document.getElementById('tool-stroke-toggle');
            if (fillToggleBtn) {
                window.AppState.fillEnabled = false;
                fillToggleBtn.classList.remove('active');
            }
            if (strokeToggleBtn) {
                window.AppState.strokeEnabled = false;
                strokeToggleBtn.classList.remove('active');
            }
        }

    } catch (err) {
        console.error('[Clipboard] Failed to process pasted image:', err);
        showToast('Failed to paste image.');
    }
});

// ---------------------------------------------------------------------------
// Canvas Resize Handler
// ---------------------------------------------------------------------------
function handleResize() {
    // The CSS handles visual scaling (width/height: 100%).
    // The intrinsic canvas dimensions (1920x1080) remain fixed.
    // This handler is a hook for future coordinate mapping logic.
}

window.addEventListener('resize', handleResize);

// ---------------------------------------------------------------------------
// Network Integration (Day 2)
// ---------------------------------------------------------------------------

/** @type {NetworkManager} Singleton network manager */
const network = window.network = new NetworkManager();

/**
 * Generate a temporary username for auto-connect.
 * Will be replaced by the Room Modal input on Day 3.
 * @returns {string}
 */
function _generateTempUsername() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 4; i++) {
        suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `User_${suffix}`;
}

/**
 * Update the status bar connection indicator.
 * @param {'connected'|'disconnected'|'connecting'} visualState
 * @param {string} label
 */
function updateConnectionStatus(visualState, label) {
    const el = DOM.statusConnection;
    // Remove all state classes
    el.classList.remove(
        'status-bar__indicator--connected',
        'status-bar__indicator--disconnected',
        'status-bar__indicator--connecting',
    );
    el.classList.add(`status-bar__indicator--${visualState}`);
    // Update text (preserve the dot span)
    const dot = el.querySelector('.status-bar__dot');
    el.textContent = '';
    if (dot) el.appendChild(dot);
    el.appendChild(document.createTextNode(' ' + label));
}

// -- Subscribe to network state changes --------------------------------------
network.on('state_change', (newState, _oldState) => {
    switch (newState) {
        case ConnectionState.CONNECTING:
            updateConnectionStatus('connecting', 'Connecting…');
            break;
        case ConnectionState.CONNECTED:
            updateConnectionStatus('connecting', 'Handshaking…');
            break;
        case ConnectionState.IDENTIFIED:
            updateConnectionStatus('connected', 'Connected');
            break;
        case ConnectionState.DISCONNECTED:
            updateConnectionStatus('disconnected', 'Disconnected');
            break;
        case ConnectionState.RECONNECTING:
            updateConnectionStatus('connecting', 'Reconnecting…');
            break;
    }
});

// -- Subscribe to hello_ack --------------------------------------------------
network.on('hello_ack', (data) => {
    AppState.userId = data.user_id;
    console.log(`[CollabBoard] Identified: ${AppState.username} (${data.user_id})`);
});

// -- Subscribe to errors -----------------------------------------------------
network.on('error', (data) => {
    console.warn(`[CollabBoard] Server error: [${data.code}] ${data.message}`);
});

// -- Day 8: Subscribe to Cursor Chat Broadcast -------------------------------
network.on('cursor_chat_broadcast', (data) => {
    renderCursorChatBubble(data.user_id, data.username, data.x, data.y, data.message);
});

// -- Subscribe to reconnect events -------------------------------------------
network.on('reconnecting', ({ attempt, maxAttempts, delay }) => {
    console.log(`[CollabBoard] Reconnect attempt ${attempt}/${maxAttempts} in ${delay}ms`);
});

network.on('reconnected', () => {
    console.log('[CollabBoard] Reconnected. Re-join room if needed.');
    // Day 3: auto re-send join_room with stored roomId
});

network.on('reconnect_failed', () => {
    console.error('[CollabBoard] All reconnect attempts failed.');
    updateConnectionStatus('disconnected', 'Connection lost');
    // TODO (Day 3): Show a reconnect button in the UI
});

// ---------------------------------------------------------------------------
// Toast Notification
// ---------------------------------------------------------------------------
function showToast(message, duration = 3000) {
    DOM.toast.textContent = message;
    DOM.toast.classList.add('visible');
    DOM.toast.setAttribute('aria-hidden', 'false');
    
    if (DOM.toast._timeout) clearTimeout(DOM.toast._timeout);
    DOM.toast._timeout = setTimeout(() => {
        DOM.toast.classList.remove('visible');
        DOM.toast.setAttribute('aria-hidden', 'true');
    }, duration);
}

// ---------------------------------------------------------------------------
// UI Dropdowns & Popovers
// ---------------------------------------------------------------------------
DOM.moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = DOM.moreOptionsDropdown.getAttribute('aria-hidden') === 'true';
    DOM.moreOptionsDropdown.setAttribute('aria-hidden', !isHidden);
});

DOM.toolShapesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = DOM.shapesPopover.getAttribute('aria-hidden') === 'true';
    DOM.shapesPopover.setAttribute('aria-hidden', !isHidden);
});

document.querySelectorAll('.popover__item').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const tool = btn.dataset.tool;
        setActiveTool(tool);
        // Update parent icon
        DOM.shapesIcon.innerHTML = btn.innerHTML;
        DOM.toolShapesBtn.dataset.tool = tool;
        DOM.shapesPopover.setAttribute('aria-hidden', 'true');
    });
});

document.addEventListener('click', (e) => {
    if (!DOM.moreOptionsDropdown.contains(e.target) && e.target !== DOM.moreBtn) {
        DOM.moreOptionsDropdown.setAttribute('aria-hidden', 'true');
    }
    if (!DOM.shapesPopover.contains(e.target) && e.target !== DOM.toolShapesBtn) {
        DOM.shapesPopover.setAttribute('aria-hidden', 'true');
    }
});

// Allow 'S' hotkey to select the active shape from the button
function selectActiveShape() {
    const tool = DOM.toolShapesBtn.dataset.tool;
    setActiveTool(tool);
}

// ---------------------------------------------------------------------------
// Export / Import .collab and PNG
// ---------------------------------------------------------------------------
DOM.pngExportBtn.addEventListener('click', () => {
    if (window.CollabCanvas) {
        window.CollabCanvas.exportToPNG();
    }
});

DOM.exportBtn.addEventListener('click', () => {
    DOM.moreOptionsDropdown.setAttribute('aria-hidden', 'true');
    if (!window.CollabCanvas) return;

    const objects = Array.from(window.CollabCanvas.objects.values());
    const payload = {
        meta: {
            version: "1.0",
            exported_at: new Date().toISOString(),
            room_id: AppState.roomId,
            object_count: objects.length
        },
        objects: objects
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `collabboard_${AppState.roomId || 'local'}_${timestamp}.collab`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${objects.length} objects successfully.`);
});

DOM.importBtn.addEventListener('click', () => {
    DOM.moreOptionsDropdown.setAttribute('aria-hidden', 'true');
    if (!AppState.roomId) {
        showToast('Please join a room before importing.');
        return;
    }
    DOM.importFile.click();
});

DOM.importFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const data = JSON.parse(event.target.result);
            if (!data.meta || !data.meta.version || !Array.isArray(data.objects)) {
                throw new Error("Invalid .collab file format.");
            }

            let count = 0;
            for (const obj of data.objects) {
                // Strip server assigned fields
                const { obj_id, created_by, created_at, seq, ...payload } = obj;
                
                // Keep properties clean
                if (payload.obj_type === 'image' && payload.properties) {
                    // image_data is not in the export, so imported images will be empty boxes unless we do something else.
                }

                // Generate temp id and optimistic add
                const generateUUID = () => {
                    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
                    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                        const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                    });
                };
                
                const tempId = 'temp-' + generateUUID();
                const optimisticObj = {
                    ...payload,
                    obj_id: tempId,
                    created_by: AppState.userId || 'local',
                    created_at: new Date().toISOString()
                };

                window.CollabCanvas.addOptimisticObject(optimisticObj);

                if (window.network && window.network.isIdentified) {
                    window.network.send({ type: 'op', op: 'add', object: optimisticObj });
                }

                count++;
                await new Promise(r => setTimeout(r, 10)); // Rate limit 10ms
            }

            showToast(`Imported ${count} objects.`);
        } catch (err) {
            console.error(err);
            showToast('Error parsing file.');
        }
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset
});

// ---------------------------------------------------------------------------
// Room & UI Helpers
// ---------------------------------------------------------------------------

// Copy room code
if (DOM.toolbarRoomName) {
    DOM.toolbarRoomName.style.cursor = 'pointer';
    DOM.toolbarRoomName.title = 'Copy room code';
    DOM.toolbarRoomName.addEventListener('click', () => {
        if (AppState.roomId) {
            navigator.clipboard.writeText(AppState.roomId).then(() => {
                const originalText = DOM.toolbarRoomName.textContent;
                DOM.toolbarRoomName.textContent = 'Copied!';
                setTimeout(() => {
                    DOM.toolbarRoomName.textContent = originalText;
                }, 2000);
            });
        }
    });
}

// Leave Room Flow
if (DOM.leaveBtn) {
    DOM.leaveBtn.addEventListener('click', () => {
        DOM.moreOptionsDropdown.setAttribute('aria-hidden', 'true');
        DOM.leaveModal.setAttribute('aria-hidden', 'false');
    });

    DOM.leaveCancelBtn.addEventListener('click', () => {
        DOM.leaveModal.setAttribute('aria-hidden', 'true');
    });

    DOM.leaveProceedBtn.addEventListener('click', () => {
        DOM.leaveModal.setAttribute('aria-hidden', 'true');
        
        // Disconnect from server
        if (window.network) {
            window.network.disconnect();
        }
        
        // Clear local state
        AppState.roomId = null;
        AppState.isHost = false;
        
        // Clear canvas
        if (window.CollabCanvas) {
            if (typeof window.CollabCanvas.clearSelection === 'function') window.CollabCanvas.clearSelection();
            if (window.CollabCanvas.objects) window.CollabCanvas.objects.clear();
            if (window.CollabCanvas.pendingAdds) window.CollabCanvas.pendingAdds = [];
        }
        
        // Clear undo/redo
        if (window.UndoRedoManager) {
            window.UndoRedoManager.undoStack = [];
            window.UndoRedoManager.redoStack = [];
            window.UndoRedoManager.updateStatus();
        }
        
        // Update UI
        DOM.roomModal.setAttribute('aria-hidden', 'false');
        DOM.statusRoom.textContent = 'No room';
        DOM.statusConnection.innerHTML = '<span class="status-bar__dot"></span>Disconnected';
        DOM.statusConnection.className = 'status-bar__indicator status-bar__indicator--disconnected';
        DOM.statusUsers.textContent = '0 users';
        DOM.participantList.innerHTML = '';
        DOM.participants.innerHTML = '';
        showToast('Left the room.');
    });
}

// ---------------------------------------------------------------------------
// UI Initialization
// ---------------------------------------------------------------------------

(function init() {
    console.log('[CollabBoard] Frontend initialized — Day 2');
    console.log('[CollabBoard] Press Ctrl+Shift+D to toggle dark mode');

    // Set initial canvas cursor
    DOM.canvas.style.cursor = 'default';

    // Initialize Canvas, Tools, and Cursor overlay (Day 4 / Day 7)
    if (window.CollabCanvas) window.CollabCanvas.init();
    if (window.ToolManager) window.ToolManager.init();
    if (window.CursorManager) window.CursorManager.init();

    // -- Show Room Modal ------------------------------------------------------
    // Day 3: Show the room join/create modal on load
    DOM.roomModal.setAttribute('aria-hidden', 'false');
    DOM.modalUsername.focus();
})();
