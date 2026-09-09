// =============================================================================
// CollabBoard — Network Layer (WebSocket Client)
// =============================================================================
// Owner : M2 (Frontend Engineer)
// Sprint: Day 2
//
// Implements the browser WebSocket client with:
//   - Auto-derived WS URL from window.location
//   - hello / hello_ack handshake on connection open
//   - JSON serialization / deserialization for all messages
//   - Exponential backoff auto-reconnect (1s, 2s, 4s, 8s, …, max 30s)
//   - App-level ping/pong heartbeat (10s interval, 5s timeout)
//   - Lightweight EventEmitter for decoupled message routing
//
// Reference:
//   - WEBSOCKET_PROTOCOL_EXTENSION.md §0 (endpoint), §1 (lifecycle),
//     §8 (heartbeat), §9 (reconnect)
//   - API_CONTRACT.md §1 (hello/hello_ack), §3 (ping/pong)
//   - IMPLEMENTATION_PLAN.md §F1
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// EventEmitter — Lightweight pub/sub for decoupled message routing
// ---------------------------------------------------------------------------

/**
 * Minimal event emitter.
 *
 * Usage:
 *   const bus = new EventEmitter();
 *   bus.on('hello_ack', (data) => console.log(data));
 *   bus.emit('hello_ack', { user_id: '...' });
 *   bus.off('hello_ack', handler);
 */
class EventEmitter {
    constructor() {
        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
    }

    /**
     * Register a listener for an event type.
     * @param {string} event
     * @param {Function} fn
     * @returns {this}
     */
    on(event, fn) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(fn);
        return this;
    }

    /**
     * Remove a listener. If no fn provided, removes all listeners for event.
     * @param {string} event
     * @param {Function} [fn]
     * @returns {this}
     */
    off(event, fn) {
        if (!fn) {
            this._listeners.delete(event);
        } else {
            const set = this._listeners.get(event);
            if (set) {
                set.delete(fn);
                if (set.size === 0) this._listeners.delete(event);
            }
        }
        return this;
    }

    /**
     * Emit an event to all registered listeners.
     * @param {string} event
     * @param {...*} args
     */
    emit(event, ...args) {
        const set = this._listeners.get(event);
        if (set) {
            for (const fn of set) {
                try {
                    fn(...args);
                } catch (err) {
                    console.error(`[EventEmitter] Error in '${event}' handler:`, err);
                }
            }
        }
    }
}


// ---------------------------------------------------------------------------
// NetworkManager — WebSocket Client
// ---------------------------------------------------------------------------

/**
 * Connection state constants.
 * @enum {string}
 */
const ConnectionState = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',   // WS open, hello not yet sent
    IDENTIFIED:   'identified',  // hello_ack received
    RECONNECTING: 'reconnecting',
});

/**
 * Manages the WebSocket connection to the CollabBoard server.
 *
 * Lifecycle:
 *   1. connect(username) → opens WS, sends hello, waits for hello_ack
 *   2. On hello_ack → state becomes IDENTIFIED, starts ping cycle
 *   3. send(msg) → JSON.stringify and transmit
 *   4. On WS close → exponential backoff reconnect (unless user-initiated)
 *
 * Events emitted:
 *   - 'state_change'  (newState, oldState)
 *   - 'hello_ack'     ({ user_id, server_version })
 *   - 'error'         ({ code, message })
 *   - 'reconnecting'  ({ attempt, delay })
 *   - 'reconnected'   ()
 *   - 'reconnect_failed' ()
 *   - '<message_type>' (data)  — for any incoming message type
 */
class NetworkManager extends EventEmitter {

    // -- Reconnect constants -------------------------------------------------
    static BACKOFF_INITIAL_MS  = 1000;
    static BACKOFF_MAX_MS      = 30000;
    static BACKOFF_MULTIPLIER  = 2;
    static MAX_RECONNECT_ATTEMPTS = 10;

    // -- Ping/pong constants -------------------------------------------------
    static PING_INTERVAL_MS    = 10000;  // Send ping every 10s
    static PONG_TIMEOUT_MS     = 5000;   // Expect pong within 5s

    constructor() {
        super();

        /** @type {WebSocket|null} */
        this._ws = null;

        /** @type {string} */
        this._state = ConnectionState.DISCONNECTED;

        /** @type {string|null} Username for hello handshake */
        this._username = null;

        /** @type {string|null} Assigned by server on hello_ack */
        this._userId = null;

        /** @type {string|null} Server version from hello_ack */
        this._serverVersion = null;

        /** @type {string|null} Current room (set by caller after join_ack) */
        this._roomId = null;

        /** @type {boolean} If true, suppress auto-reconnect */
        this._userInitiatedClose = false;

        // -- Reconnect state -------------------------------------------------
        /** @type {number} Current retry attempt (0-based) */
        this._reconnectAttempt = 0;

        /** @type {number|null} setTimeout ID for reconnect delay */
        this._reconnectTimer = null;

        // -- Ping/pong state -------------------------------------------------
        /** @type {number|null} setInterval ID for ping cycle */
        this._pingInterval = null;

        /** @type {number|null} setTimeout ID for pong timeout */
        this._pongTimeout = null;

        /** @type {boolean} Whether we're waiting for a pong */
        this._awaitingPong = false;
    }

    // -----------------------------------------------------------------------
    // Public Properties
    // -----------------------------------------------------------------------

    /** @returns {string} Current connection state */
    get state()         { return this._state; }

    /** @returns {string|null} */
    get userId()        { return this._userId; }

    /** @returns {string|null} */
    get username()      { return this._username; }

    /** @returns {string|null} */
    get serverVersion() { return this._serverVersion; }

    /** @returns {string|null} */
    get roomId()        { return this._roomId; }

    /** @returns {boolean} */
    get isIdentified()  { return this._state === ConnectionState.IDENTIFIED; }

    // -----------------------------------------------------------------------
    // Public: connect
    // -----------------------------------------------------------------------

    /**
     * Open a WebSocket connection and perform the hello handshake.
     *
     * @param {string} username — Display name to send in the hello message.
     * @param {string} [wsUrl]  — Optional override for the WebSocket URL.
     *                            Defaults to auto-derived from window.location.
     */
    connect(username, wsUrl) {
        if (this._ws && this._ws.readyState <= WebSocket.OPEN) {
            console.warn('[Network] Already connected or connecting. Call disconnect() first.');
            return;
        }

        this._username = username;
        this._userInitiatedClose = false;
        this._reconnectAttempt = 0;

        const url = wsUrl || this._deriveWsUrl();
        this._openWebSocket(url);
    }

    // -----------------------------------------------------------------------
    // Public: disconnect
    // -----------------------------------------------------------------------

    /**
     * Gracefully close the WebSocket connection.
     * Suppresses auto-reconnect.
     */
    disconnect() {
        this._userInitiatedClose = true;
        this._clearTimers();

        if (this._ws) {
            try {
                this._ws.close(1000, 'User initiated disconnect');
            } catch (_) {
                // Already closed
            }
            this._ws = null;
        }

        this._setState(ConnectionState.DISCONNECTED);
    }

    // -----------------------------------------------------------------------
    // Public: send
    // -----------------------------------------------------------------------

    /**
     * Send a JSON message over the WebSocket.
     *
     * @param {object} message — Object to JSON.stringify and send.
     * @returns {boolean} True if the message was sent, false if not connected.
     */
    send(message) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            console.warn('[Network] Cannot send — WebSocket is not open.', message);
            return false;
        }

        try {
            const raw = JSON.stringify(message);
            this._ws.send(raw);
            return true;
        } catch (err) {
            console.error('[Network] Send failed:', err);
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Public: setRoomId (called by main.js after join_ack)
    // -----------------------------------------------------------------------

    /**
     * Update the stored room ID. Used for reconnect auto-rejoin (Day 3).
     * @param {string|null} roomId
     */
    setRoomId(roomId) {
        this._roomId = roomId;
    }

    // -----------------------------------------------------------------------
    // Private: WebSocket lifecycle
    // -----------------------------------------------------------------------

    /**
     * Derive the WebSocket URL from the current page location.
     * http → ws, https → wss. Path is always /ws.
     * @returns {string}
     */
    _deriveWsUrl() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${window.location.host}/ws`;
    }

    /**
     * Create a new WebSocket and bind event handlers.
     * @param {string} url
     */
    _openWebSocket(url) {
        this._setState(ConnectionState.CONNECTING);
        console.log(`[Network] Connecting to ${url}...`);

        try {
            this._ws = new WebSocket(url);
        } catch (err) {
            console.error('[Network] WebSocket constructor failed:', err);
            this._handleConnectionFailure();
            return;
        }

        this._ws.onopen    = () => this._onOpen();
        this._ws.onmessage = (event) => this._onMessage(event);
        this._ws.onclose   = (event) => this._onClose(event);
        this._ws.onerror   = (event) => this._onError(event);
    }

    // -----------------------------------------------------------------------
    // WebSocket event handlers
    // -----------------------------------------------------------------------

    /** Called when the WebSocket connection opens successfully. */
    _onOpen() {
        console.log('[Network] WebSocket opened. Sending hello...');
        this._setState(ConnectionState.CONNECTED);

        // Immediately send the hello handshake
        this.send({
            type: 'hello',
            username: this._username,
        });
    }

    /**
     * Called on every incoming WebSocket text frame.
     * Parses JSON and routes by message type.
     * @param {MessageEvent} event
     */
    _onMessage(event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (err) {
            console.error('[Network] Failed to parse server message:', event.data);
            return;
        }

        const type = data.type;
        if (!type) {
            console.warn('[Network] Received message without type field:', data);
            return;
        }

        // Route special message types first
        switch (type) {
            case 'hello_ack':
                this._handleHelloAck(data);
                break;

            case 'pong':
                this._handlePong();
                break;

            case 'error':
                console.warn(`[Network] Server error: [${data.code}] ${data.message}`);
                this.emit('error', data);
                break;

            default:
                // Emit the raw message type so any module can subscribe
                // e.g., 'join_ack', 'op_broadcast', 'canvas_snapshot', etc.
                break;
        }

        // Always emit the message type as an event (including hello_ack, error, etc.)
        // This lets multiple subscribers react to the same message.
        this.emit(type, data);
    }

    /**
     * Called when the WebSocket connection is closed.
     * @param {CloseEvent} event
     */
    _onClose(event) {
        console.log(
            `[Network] WebSocket closed: code=${event.code}, reason="${event.reason}", clean=${event.wasClean}`
        );

        this._clearTimers();
        this._ws = null;

        const wasIdentified = this._state === ConnectionState.IDENTIFIED;

        this._setState(ConnectionState.DISCONNECTED);

        // Decide whether to auto-reconnect
        if (this._userInitiatedClose) {
            console.log('[Network] User-initiated close — not reconnecting.');
            return;
        }

        if (wasIdentified || this._state === ConnectionState.CONNECTED) {
            // Connection dropped unexpectedly — attempt reconnect
            this._scheduleReconnect();
        }
    }

    /**
     * Called on WebSocket error. The close event typically follows.
     * @param {Event} event
     */
    _onError(event) {
        console.error('[Network] WebSocket error:', event);
        // The onclose handler will fire next and handle reconnection
    }

    // -----------------------------------------------------------------------
    // Hello handshake
    // -----------------------------------------------------------------------

    /**
     * Process a successful hello_ack from the server.
     * @param {{ user_id: string, server_version: string }} data
     */
    _handleHelloAck(data) {
        this._userId = data.user_id;
        this._serverVersion = data.server_version;

        this._setState(ConnectionState.IDENTIFIED);

        console.log(
            `[Network] Identified as "${this._username}" (${this._userId}), ` +
            `server v${this._serverVersion}`
        );

        // If this was a reconnect, notify subscribers
        if (this._reconnectAttempt > 0) {
            this._reconnectAttempt = 0;
            this.emit('reconnected');
            console.log('[Network] Reconnected successfully.');
        }

        // Start the app-level ping cycle
        this._startPingCycle();
    }

    // -----------------------------------------------------------------------
    // Ping / Pong heartbeat
    // -----------------------------------------------------------------------

    /** Start sending periodic pings to detect silent server death. */
    _startPingCycle() {
        this._stopPingCycle();

        this._pingInterval = setInterval(() => {
            if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
                this._stopPingCycle();
                return;
            }

            // Send app-level ping
            this.send({ type: 'ping' });
            this._awaitingPong = true;

            // Start pong timeout
            this._pongTimeout = setTimeout(() => {
                if (this._awaitingPong) {
                    console.warn('[Network] Pong timeout — server presumed dead.');
                    this._awaitingPong = false;
                    // Force close — this triggers onClose → reconnect
                    if (this._ws) {
                        try {
                            this._ws.close(4000, 'Pong timeout');
                        } catch (_) { /* ignore */ }
                    }
                }
            }, NetworkManager.PONG_TIMEOUT_MS);

        }, NetworkManager.PING_INTERVAL_MS);
    }

    /** Stop the ping cycle and clear any pending pong timeout. */
    _stopPingCycle() {
        if (this._pingInterval !== null) {
            clearInterval(this._pingInterval);
            this._pingInterval = null;
        }
        if (this._pongTimeout !== null) {
            clearTimeout(this._pongTimeout);
            this._pongTimeout = null;
        }
        this._awaitingPong = false;
    }

    /** Handle an incoming pong response. */
    _handlePong() {
        this._awaitingPong = false;
        if (this._pongTimeout !== null) {
            clearTimeout(this._pongTimeout);
            this._pongTimeout = null;
        }
    }

    // -----------------------------------------------------------------------
    // Reconnect with exponential backoff
    // -----------------------------------------------------------------------

    /**
     * Schedule a reconnection attempt with exponential backoff.
     *
     * Backoff sequence: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
     * Max attempts: 10 (then emits 'reconnect_failed')
     */
    _scheduleReconnect() {
        if (this._reconnectAttempt >= NetworkManager.MAX_RECONNECT_ATTEMPTS) {
            console.error(
                `[Network] Max reconnect attempts (${NetworkManager.MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`
            );
            this._setState(ConnectionState.DISCONNECTED);
            this.emit('reconnect_failed');
            return;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(
            NetworkManager.BACKOFF_INITIAL_MS * Math.pow(NetworkManager.BACKOFF_MULTIPLIER, this._reconnectAttempt),
            NetworkManager.BACKOFF_MAX_MS,
        );

        this._reconnectAttempt++;

        console.log(
            `[Network] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt}/${NetworkManager.MAX_RECONNECT_ATTEMPTS})...`
        );

        this._setState(ConnectionState.RECONNECTING);
        this.emit('reconnecting', {
            attempt: this._reconnectAttempt,
            delay,
            maxAttempts: NetworkManager.MAX_RECONNECT_ATTEMPTS,
        });

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            const url = this._deriveWsUrl();
            this._openWebSocket(url);
        }, delay);
    }

    /**
     * Handle a connection failure that occurred before the WS could open.
     * Triggers the reconnect flow.
     */
    _handleConnectionFailure() {
        this._setState(ConnectionState.DISCONNECTED);
        if (!this._userInitiatedClose) {
            this._scheduleReconnect();
        }
    }

    // -----------------------------------------------------------------------
    // Internal: state management
    // -----------------------------------------------------------------------

    /**
     * Update the connection state and emit a state_change event.
     * @param {string} newState
     */
    _setState(newState) {
        if (this._state === newState) return;
        const oldState = this._state;
        this._state = newState;
        this.emit('state_change', newState, oldState);
    }

    /**
     * Clear all active timers (reconnect, ping, pong).
     */
    _clearTimers() {
        this._stopPingCycle();
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
}

// ---------------------------------------------------------------------------
// Export as globals (no ES module bundler — plain <script> tags)
// ---------------------------------------------------------------------------
window.EventEmitter    = EventEmitter;
window.NetworkManager  = NetworkManager;
window.ConnectionState = ConnectionState;
