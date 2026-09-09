// =============================================================================
// CollabBoard — Canvas Renderer
// =============================================================================
// Owner : M2 (Frontend Engineer)
// Sprint: Day 7
//
// Manages the HTML5 Canvas, maintains the authoritative list of committed
// drawing objects, and runs the requestAnimationFrame render loop.
//
// Features:
//   - Fixed 1920x1080 logical coordinate space.
//   - 60fps render loop clearing and redrawing all objects.
//   - Delegates rendering of the in-progress tool stroke to ToolManager.
//   - Listens to network events for incoming snapshot and broadcast data.
//   - Full shape rendering: pencil, rectangle, circle, line, arrow, heart, text.
//   - Stores snapshot seq number for future undo/redo tracking.
//
// Day 7 additions:
//   - CursorManager: parses cursor_update events, renders remote cursors
//     as absolute-positioned HTML overlays (not drawn on canvas).
//   - Emits throttled cursor_move (50ms) on mouse motion.
// =============================================================================

'use strict';

class CanvasRenderer {
    constructor() {
        this.canvas = document.getElementById('canvas');
        /** @type {CanvasRenderingContext2D} */
        this.ctx = this.canvas.getContext('2d');
        
        // Logical canvas dimensions defined in SPECIFICATION.md
        this.WIDTH = 1920;
        this.HEIGHT = 1080;

        /** 
         * The committed state of the canvas.
         * A Map of object payloads received from the server or local. 
         * @type {Map<string, Object>} 
         */
        this.objects = new Map();

        /**
         * Last known sequence number from the server.
         * Updated on canvas_snapshot and op_ack/op_broadcast.
         * @type {number}
         */
        this.lastSeq = 0;
        
        /**
         * Queue of temporary IDs awaiting op_ack for 'add' operations.
         * @type {string[]}
         */
        this.pendingAdds = [];

        /**
         * Tombstones: Set of deleted object IDs to handle network race conditions
         * (e.g. if a delete arrives before the add broadcast).
         * @type {Set<string>}
         */
        this.tombstones = new Set();

        /**
         * Remote selections map: user_id -> { obj_id, username }
         * @type {Map<string, {obj_id: string, username: string}>}
         */
        this.remoteSelections = new Map();

        /**
         * Phase 2, Sprint 5: Remote streams (active strokes)
         * @type {Map<string, Object>}
         */
        this.remoteStreams = new Map();

        /**
         * Selection State (Phase 2, Sprint 3)
         */
        this.selectedObjectId = null;
        this.selectedHandle = null;
        this.isResizing = false;
        this.resizeStart = null;

        /**
         * Day 10: Cache of HTMLImageElement instances keyed by base64 data hash.
         * Prevents re-creating Image objects every frame in the render loop.
         * @type {Map<string, HTMLImageElement>}
         */
        this.imageCache = new Map();

        // Bind the render loop to this instance
        this.renderLoop = this.renderLoop.bind(this);
    }

    init() {
        console.log(`[CollabCanvas] Initialized. Logical size: ${this.WIDTH}x${this.HEIGHT}`);

        // Set up network listeners for incoming canvas data
        if (window.network) {
            window.network.on('canvas_snapshot', (data) => this.handleSnapshot(data));
            window.network.on('op_broadcast', (data) => this.handleOpBroadcast(data));
            window.network.on('op_ack', (data) => this.handleOpAck(data));
            window.network.on('selection_update', (data) => this.handleSelectionUpdate(data));
            window.network.on('stream_points', (data) => this.handleStreamPoints(data));
            window.network.on('stream_end', (data) => this.handleStreamEnd(data));
            window.network.on('user_left', (data) => {
                this.remoteSelections.delete(data.user_id);
                this.remoteStreams.delete(data.user_id);
            });
        }

        // Start the render loop
        requestAnimationFrame(this.renderLoop);
    }

    /**
     * Handles the initial snapshot from the server.
     * Merges the state by preserving any un-acked local 'temp-' strokes 
     * to prevent data loss on quick reconnects.
     * @param {Object} data - The canvas_snapshot payload
     */
    handleSnapshot(data) {
        console.log(`[CollabCanvas] Received snapshot with ${data.objects.length} objects, seq=${data.seq}.`);
        
        // Store the server's current sequence number
        if (data.seq !== undefined) {
            this.lastSeq = data.seq;
        }

        // Preserve local pending temp objects
        const preservedTemps = new Map();
        for (const [id, obj] of this.objects.entries()) {
            if (id.startsWith('temp-')) {
                preservedTemps.set(id, obj);
            }
        }

        // Wipe authoritative state — snapshot is the server's truth
        this.objects.clear();
        
        // Clear tombstones — snapshot is a fresh baseline
        this.tombstones.clear();

        // Restore local pending temp objects
        for (const [id, obj] of preservedTemps.entries()) {
            this.objects.set(id, obj);
        }

        // Load snapshot objects
        for (const obj of data.objects) {
            this.objects.set(obj.obj_id, obj);
        }
    }

    /**
     * Handles an operation broadcast from another user.
     * @param {Object} data - The op_broadcast payload
     */
    handleOpBroadcast(data) {
        if (data.op === 'add') {
            const obj = data.object;
            // Prevent adding an object if a delete already arrived for it
            if (this.tombstones.has(obj.obj_id)) return;

            if (data.seq !== undefined) obj.seq = data.seq;
            this.objects.set(obj.obj_id, obj);
        } else if (data.op === 'modify') {
            const existing = this.objects.get(data.obj_id);
            if (existing) {
                // Instantly snap to new coordinates/styles (no tweening)
                const changes = data.changes || {};
                if (changes.color) existing.color = changes.color;
                if (changes.stroke_width !== undefined) existing.stroke_width = changes.stroke_width;
                if (changes.z_index !== undefined) existing.z_index = changes.z_index;
                if (changes.properties) {
                    existing.properties = { ...existing.properties, ...changes.properties };
                }
                if (data.seq !== undefined) existing.seq = data.seq;
            }
        } else if (data.op === 'delete') {
            // Track the deletion to handle out-of-order packets
            this.tombstones.add(data.obj_id);
            
            // Remove the object entirely from local state
            this.objects.delete(data.obj_id);

            // Phase 2, Sprint 3: Handle remote delete of selected object
            if (this.selectedObjectId === data.obj_id) {
                this.clearSelection();
            }
        }
    }

    /**
     * Handles acknowledgment of our own operation.
     * @param {Object} data - The op_ack payload
     */
    handleOpAck(data) {
        if (!this.objects.has(data.obj_id)) {
            // Ack for a new 'add' operation
            if (this.pendingAdds.length > 0) {
                const tempId = this.pendingAdds.shift();
                const obj = this.objects.get(tempId);
                if (obj) {
                    obj.obj_id = data.obj_id;
                    obj.seq = data.seq;
                    this.objects.delete(tempId);
                    this.objects.set(data.obj_id, obj);
                    
                    if (window.UndoRedoManager) {
                        window.UndoRedoManager.updateObjectId(tempId, data.obj_id);
                    }
                    
                    // If this object was selected locally, update the selection ID
                    if (this.selectedObjectId === tempId) {
                        this.selectObject(data.obj_id);
                    }
                }
            }
        } else {
            // Ack for modify or delete
            const obj = this.objects.get(data.obj_id);
            if (obj) {
                obj.seq = data.seq;
            }
        }
    }

    /**
     * Adds an object directly to the local state (optimistic update).
     * @param {Object} obj 
     */
    addOptimisticObject(obj) {
        this.objects.set(obj.obj_id, obj);
        if (obj.obj_id.startsWith('temp-')) {
            this.pendingAdds.push(obj.obj_id);
        }
    }

    /**
     * Removes an object optimistically (e.g., from an undo operation).
     * @param {string} objId 
     */
    removeOptimisticObject(objId) {
        this.objects.delete(objId);
    }

    /**
     * Modifies an object optimistically.
     * @param {string} objId 
     * @param {Object} changes 
     */
    modifyOptimisticObject(objId, changes) {
        const obj = this.objects.get(objId);
        if (obj) {
            Object.assign(obj, changes);
        }
    }

    handleSelectionUpdate(data) {
        if (data.user_id === window.AppState?.userId) return;
        if (data.obj_id) {
            this.remoteSelections.set(data.user_id, { obj_id: data.obj_id, username: data.username });
        } else {
            this.remoteSelections.delete(data.user_id);
        }
    }

    // --- Phase 2, Sprint 5: Remote Streams ---

    handleStreamPoints(data) {
        if (data.user_id === window.AppState?.userId) return;
        this.remoteStreams.set(data.user_id, {
            obj_type: data.obj_type,
            color: data.color,
            stroke_width: data.stroke_width,
            properties: { points: data.points }
        });
    }

    handleStreamEnd(data) {
        this.remoteStreams.delete(data.user_id);
    }

    // --- Selection Helpers (Phase 2, Sprint 3) ---

    selectObject(objId) { 
        if (this.selectedObjectId !== objId) {
            this.selectedObjectId = objId; 
            if (window.network && window.network.isIdentified && window.AppState?.roomId) {
                window.network.send({ type: 'selection_update', obj_id: objId });
            }
        }
    }
    
    clearSelection() { 
        if (this.selectedObjectId !== null) {
            this.selectedObjectId = null; 
            this.selectedHandle = null; 
            this.isResizing = false;
            this.resizeStart = null;
            if (window.network && window.network.isIdentified && window.AppState?.roomId) {
                window.network.send({ type: 'selection_update', obj_id: null });
            }
        }
    }
    
    getSelectedObject() { 
        if (!this.selectedObjectId) return null;
        return this.objects.get(this.selectedObjectId) || null; 
    }

    /**
     * Core render loop called by requestAnimationFrame.
     */
    renderLoop() {
        // 1. Clear the canvas
        this.ctx.clearRect(0, 0, this.WIDTH, this.HEIGHT);

        // 2. Set default styles
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        // Sort objects by z_index, then by seq (fallback)
        const sortedObjects = Array.from(this.objects.values()).sort((a, b) => {
            if (a.z_index !== b.z_index) return a.z_index - b.z_index;
            return (a.seq || 0) - (b.seq || 0);
        });

        // 3. Draw all committed objects
        for (const obj of sortedObjects) {
            if (!obj.is_deleted) {
                this.drawObject(obj);
            }
        }

        // 4. Draw selection box and handles
        if (this.selectedObjectId) {
            const selectedObj = this.objects.get(this.selectedObjectId);
            if (selectedObj) {
                this.drawSelection(selectedObj);
            } else {
                // Object was deleted remotely
                this.clearSelection();
            }
        }

        // 4.5 Draw remote selections
        for (const [userId, selection] of this.remoteSelections.entries()) {
            const selectedObj = this.objects.get(selection.obj_id);
            if (selectedObj && !selectedObj.is_deleted) {
                this.drawRemoteSelection(selectedObj, selection.username);
            } else if (!selectedObj) {
                this.remoteSelections.delete(userId);
            }
        }

        // 4.75 Draw remote streams (Phase 2, Sprint 5)
        this.ctx.globalAlpha = 0.5;
        for (const [userId, stream] of this.remoteStreams) {
            this.drawObject(stream);
        }
        this.ctx.globalAlpha = 1.0;

        // 5. Draw the in-progress tool stroke on top
        if (window.ToolManager) {
            window.ToolManager.renderPreview(this.ctx);
        }

        // Schedule next frame
        requestAnimationFrame(this.renderLoop);
    }

    /**
     * Renders a single canvas object based on its obj_type.
     * @param {Object} obj 
     */
    drawObject(obj) {
        const { obj_type, color, stroke_width, properties } = obj;

        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = stroke_width;
        
        if (properties.fill_color) {
            this.ctx.fillStyle = properties.fill_color;
        } else {
            this.ctx.fillStyle = 'transparent';
        }

        this.ctx.beginPath();

        switch (obj_type) {
            case 'pencil':
                if (properties.points && properties.points.length > 0) {
                    this.ctx.moveTo(properties.points[0][0], properties.points[0][1]);
                    for (let i = 1; i < properties.points.length; i++) {
                        this.ctx.lineTo(properties.points[i][0], properties.points[i][1]);
                    }
                    this.ctx.stroke();
                }
                break;

            case 'rectangle':
                if (properties.fill_color) {
                    this.ctx.fillRect(properties.x, properties.y, properties.width, properties.height);
                }
                if (stroke_width > 0) {
                    this.ctx.strokeRect(properties.x, properties.y, properties.width, properties.height);
                }
                break;

            case 'circle': {
                const { cx, cy, radius } = properties;
                this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                if (properties.fill_color) {
                    this.ctx.fill();
                }
                if (stroke_width > 0) {
                    this.ctx.stroke();
                }
                break;
            }

            case 'line':
                this.ctx.moveTo(properties.x1, properties.y1);
                this.ctx.lineTo(properties.x2, properties.y2);
                this.ctx.stroke();
                break;

            case 'arrow': {
                // Draw the line
                const { x1, y1, x2, y2 } = properties;
                this.ctx.moveTo(x1, y1);
                this.ctx.lineTo(x2, y2);
                this.ctx.stroke();

                // Draw the arrowhead
                const headLen = Math.max(10, stroke_width * 3);
                const angle = Math.atan2(y2 - y1, x2 - x1);
                this.ctx.beginPath();
                this.ctx.moveTo(x2, y2);
                this.ctx.lineTo(
                    x2 - headLen * Math.cos(angle - Math.PI / 6),
                    y2 - headLen * Math.sin(angle - Math.PI / 6)
                );
                this.ctx.moveTo(x2, y2);
                this.ctx.lineTo(
                    x2 - headLen * Math.cos(angle + Math.PI / 6),
                    y2 - headLen * Math.sin(angle + Math.PI / 6)
                );
                this.ctx.stroke();
                break;
            }

            case 'heart': {
                // Heart shape using cubic Bezier curves, parametrized by cx, cy, size
                const { cx: hx, cy: hy, size } = properties;
                const s = size / 2;
                this.ctx.moveTo(hx, hy + s * 0.4);
                // Left side
                this.ctx.bezierCurveTo(
                    hx - s * 1.2, hy - s * 0.6,
                    hx - s * 0.6, hy - s * 1.4,
                    hx, hy - s * 0.6
                );
                // Right side
                this.ctx.bezierCurveTo(
                    hx + s * 0.6, hy - s * 1.4,
                    hx + s * 1.2, hy - s * 0.6,
                    hx, hy + s * 0.4
                );
                this.ctx.closePath();
                if (properties.fill_color) {
                    this.ctx.fill();
                }
                if (stroke_width > 0) {
                    this.ctx.stroke();
                }
                break;
            }

            case 'text': {
                const fontSize = properties.font_size || 16;
                this.ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
                this.ctx.fillStyle = color;
                this.ctx.textBaseline = 'top';
                
                const textContent = properties.content || '';
                const lines = textContent.split('\n');
                const lineHeight = fontSize * 1.2;
                
                for (let i = 0; i < lines.length; i++) {
                    this.ctx.fillText(lines[i], properties.x, properties.y + (i * lineHeight));
                }
                
                // Text is not stroked by default
                break;
            }

            case 'image':
                if (properties.base64 && properties.width && properties.height) {
                    // Use a short hash of the base64 string as cache key
                    const cacheKey = properties.base64.substring(0, 64) + '_' + properties.base64.length;
                    let img = this.imageCache.get(cacheKey);
                    if (!img) {
                        img = new Image();
                        img.src = properties.base64;
                        this.imageCache.set(cacheKey, img);
                    }
                    // Only draw once the image has fully decoded
                    if (img.complete && img.naturalWidth > 0) {
                        this.ctx.drawImage(img, properties.x, properties.y, properties.width, properties.height);
                    }
                } else if (properties.width && properties.height) {
                    // Fallback placeholder if no base64 data (legacy objects)
                    this.ctx.strokeStyle = '#888';
                    this.ctx.setLineDash([6, 4]);
                    this.ctx.strokeRect(properties.x, properties.y, properties.width, properties.height);
                    this.ctx.setLineDash([]);
                    this.ctx.fillStyle = '#aaa';
                    this.ctx.font = '14px Inter, system-ui, sans-serif';
                    this.ctx.textBaseline = 'middle';
                    this.ctx.textAlign = 'center';
                    this.ctx.fillText(
                        '🖼 Image',
                        properties.x + properties.width / 2,
                        properties.y + properties.height / 2
                    );
                    this.ctx.textAlign = 'start';
                }
                break;

            default:
                console.warn(`[CollabCanvas] Unknown obj_type: ${obj_type}`);
                break;
        }
    }

    /**
     * Phase 2, Sprint 3: Draw selection bounding box and handles.
     */
    drawSelection(obj) {
        if (!window.geometry) return;

        this.ctx.save();
        
        // Use an accent color for selection
        const selectionColor = '#0d99ff'; 

        // Draw bounding box
        if (obj.obj_type !== 'line' && obj.obj_type !== 'arrow' && obj.obj_type !== 'pencil') {
            const bbox = window.geometry.getBoundingBox(obj, this.ctx);
            this.ctx.strokeStyle = selectionColor;
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([4, 4]); // Dashed line
            this.ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
        }

        this.ctx.setLineDash([]); // Reset dash for handles

        // Draw resize handles
        const handles = window.geometry.getHandles(obj, this.ctx);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.strokeStyle = selectionColor;
        this.ctx.lineWidth = 1.5;
        
        const hs = 5; // 10x10 handle

        for (const h of handles) {
            this.ctx.beginPath();
            if (this.ctx.roundRect) {
                this.ctx.roundRect(h.x - hs, h.y - hs, hs * 2, hs * 2, 2);
            } else {
                this.ctx.rect(h.x - hs, h.y - hs, hs * 2, hs * 2);
            }
            this.ctx.fill();
            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    /**
     * Phase 2, Sprint 4.5: Draw remote selection bounding box and name tag.
     */
    drawRemoteSelection(obj, username) {
        if (!window.geometry) return;
        
        // Reuse hue logic
        const hue = Array.from(username).reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
        const color = `hsl(${hue}, 70%, 50%)`;

        this.ctx.save();
        
        const bbox = window.geometry.getBoundingBox(obj, this.ctx);
        
        // Bounding box outline
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([]);
        this.ctx.strokeRect(bbox.x, bbox.y, bbox.width, bbox.height);
        
        // Name tag background
        this.ctx.font = '12px Inter, system-ui, sans-serif';
        const textWidth = this.ctx.measureText(username).width;
        const padX = 6;
        const tagHeight = 20;
        
        this.ctx.fillStyle = color;
        if (this.ctx.roundRect) {
            this.ctx.beginPath();
            this.ctx.roundRect(bbox.x, bbox.y - tagHeight, textWidth + padX * 2, tagHeight, [4, 4, 0, 0]);
            this.ctx.fill();
        } else {
            this.ctx.fillRect(bbox.x, bbox.y - tagHeight, textWidth + padX * 2, tagHeight);
        }
        
        // Name tag text
        this.ctx.fillStyle = '#ffffff';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(username, bbox.x + padX, bbox.y - tagHeight / 2);

        this.ctx.restore();
    }

    /**
     * Day 9: Export the canvas as a PNG image.
     * Composites a solid background matching the current container style
     * before overlaying the transparent drawing canvas.
     */
    exportToPNG() {
        console.log('[CollabCanvas] Exporting to PNG...');
        
        // Create an offscreen canvas of the same dimensions
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;
        const tempCtx = tempCanvas.getContext('2d');

        // Capture the current background color from the container
        const container = document.getElementById('canvas-container');
        const computedStyle = window.getComputedStyle(container);
        tempCtx.fillStyle = computedStyle.backgroundColor || '#ffffff';
        tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

        // Temporarily point this.ctx to tempCtx to reuse drawObject
        const originalCtx = this.ctx;
        this.ctx = tempCtx;

        // Draw committed objects (Z-index sorted)
        const sortedObjects = Array.from(this.objects.values()).sort((a, b) => a.z_index - b.z_index);
        for (const obj of sortedObjects) {
            this.drawObject(obj);
        }

        // Draw pending optimistic objects
        for (const obj of this.pendingAdds) {
            this.drawObject(obj);
        }

        // Restore original rendering context
        this.ctx = originalCtx;

        // Generate PNG data URL
        const dataUrl = tempCanvas.toDataURL('image/png');

        // Construct filename: CollabBoard_{RoomID}_{Timestamp}.png
        const roomId = window.AppState.roomId || 'local';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `CollabBoard_${roomId}_${timestamp}.png`;

        // Trigger browser download
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}

// Export as global
window.CollabCanvas = new CanvasRenderer();


// =============================================================================
// CursorManager — Remote Cursor HTML Overlays
// =============================================================================
// Renders remote users' cursors as absolutely-positioned HTML elements
// inside #cursor-overlay. NOT drawn on the canvas (avoids smearing).
//
// Also emits outgoing cursor_move messages, throttled to 50ms.
// =============================================================================

class CursorManager {
    constructor() {
        this.overlay = document.getElementById('cursor-overlay');
        this.canvas = document.getElementById('canvas');

        /**
         * Map of user_id → { element: HTMLDivElement, username: string }
         * @type {Map<string, {element: HTMLDivElement, username: string}>}
         */
        this.cursors = new Map();

        // Throttle state for outgoing cursor_move
        this._lastCursorSendTime = 0;
        this._cursorMoveThrottleMs = 50; // 20 msgs/sec max

        // Bind
        this._onMouseMove = this._onMouseMove.bind(this);
    }

    init() {
        console.log('[CursorManager] Initialized.');

        // Listen for incoming cursor updates
        if (window.network) {
            window.network.on('cursor_update', (data) => this.handleCursorUpdate(data));
            window.network.on('user_left', (data) => this.removeCursor(data.user_id));
        }

        // Emit outgoing cursor_move on mouse motion over the canvas
        this.canvas.addEventListener('mousemove', this._onMouseMove);
    }

    /**
     * Converts logical 1920x1080 coordinates to CSS pixel offsets
     * relative to the canvas container.
     * @param {number} logicalX
     * @param {number} logicalY
     * @returns {{px: number, py: number}}
     */
    logicalToCSS(logicalX, logicalY) {
        const rect = this.canvas.getBoundingClientRect();
        const px = (logicalX / 1920) * rect.width;
        const py = (logicalY / 1080) * rect.height;
        return { px, py };
    }

    /**
     * Converts a CSS mouse position to logical 1920x1080 coordinates.
     * @param {MouseEvent} e
     * @returns {{x: number, y: number}}
     */
    cssToLogical(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = Math.round(((e.clientX - rect.left) / rect.width) * 1920);
        const y = Math.round(((e.clientY - rect.top) / rect.height) * 1080);
        return {
            x: Math.max(0, Math.min(1920, x)),
            y: Math.max(0, Math.min(1080, y)),
        };
    }

    /**
     * Generates a deterministic hue from a username string.
     * @param {string} username
     * @returns {number} hue 0–359
     */
    _hueFromUsername(username) {
        return Array.from(username).reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
    }

    /**
     * Creates the SVG cursor arrow icon.
     * @param {string} fillColor
     * @returns {string} SVG markup
     */
    _cursorSVG(fillColor) {
        return `<svg width="16" height="20" viewBox="0 0 16 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L1 17L5.5 12.5L9.5 19L12 18L8 11L14 11L1 1Z"
                  fill="${fillColor}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>`;
    }

    /**
     * Handles an incoming cursor_update from the server.
     * Creates or moves the DOM element for this remote cursor.
     * @param {{ user_id: string, username: string, x: number, y: number }} data
     */
    handleCursorUpdate(data) {
        // Ignore our own cursor (server should exclude, but guard anyway)
        if (data.user_id === window.AppState?.userId) return;

        const { px, py } = this.logicalToCSS(data.x, data.y);

        let entry = this.cursors.get(data.user_id);
        if (!entry) {
            // Create a new cursor element
            entry = this._createCursorElement(data.user_id, data.username);
            this.cursors.set(data.user_id, entry);
        }

        // Update position via transform (GPU accelerated, avoids layout thrash)
        entry.element.style.transform = `translate(${px}px, ${py}px)`;
    }

    /**
     * Creates the DOM structure for a remote cursor.
     * @param {string} userId
     * @param {string} username
     * @returns {{element: HTMLDivElement, username: string}}
     */
    _createCursorElement(userId, username) {
        const hue = this._hueFromUsername(username);
        const color = `hsl(${hue}, 70%, 50%)`;

        const el = document.createElement('div');
        el.className = 'remote-cursor';
        el.dataset.userId = userId;
        el.innerHTML = this._cursorSVG(color);

        // Username label
        const label = document.createElement('div');
        label.className = 'remote-cursor__label';
        label.textContent = username;
        label.style.backgroundColor = color;
        el.appendChild(label);

        this.overlay.appendChild(el);

        return { element: el, username };
    }

    /**
     * Removes a remote cursor from the DOM.
     * @param {string} userId
     */
    removeCursor(userId) {
        const entry = this.cursors.get(userId);
        if (entry) {
            entry.element.remove();
            this.cursors.delete(userId);
        }
    }

    /**
     * Removes all remote cursors (e.g. on room leave).
     */
    removeAll() {
        for (const [userId, entry] of this.cursors) {
            entry.element.remove();
        }
        this.cursors.clear();
    }

    /**
     * Mouse move handler — emits throttled cursor_move to the server.
     * @param {MouseEvent} e
     */
    _onMouseMove(e) {
        const now = performance.now();
        if (now - this._lastCursorSendTime < this._cursorMoveThrottleMs) return;
        this._lastCursorSendTime = now;

        if (!window.network || !window.network.isIdentified) return;
        if (!window.AppState?.roomId) return;

        const { x, y } = this.cssToLogical(e);
        window.network.send({
            type: 'cursor_move',
            x: x,
            y: y,
        });
    }
}

// Export as global
window.CursorManager = new CursorManager();
