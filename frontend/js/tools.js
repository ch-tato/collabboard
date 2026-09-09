// =============================================================================
// CollabBoard — Tool Manager
// =============================================================================
// Owner : M2 (Frontend Engineer)
// Sprint: Day 4
//
// Manages user interaction with the canvas to produce drawing primitives.
// Translates DOM mouse events into 1920x1080 logical coordinates.
// Previews the current stroke during drag and dispatches `op: add` payloads
// to the network upon completion.
//
// Supported Tools (Day 4): Pencil, Rectangle
// =============================================================================

'use strict';

class ToolManagerClass {
    constructor() {
        this.canvas = document.getElementById('canvas');
        
        this.isDrawing = false;
        
        // Stores the state of the current stroke/shape in progress
        this.activePreview = null;
        this.hoverPreview = null;

        // Phase 2, Sprint 5: Stroke Streaming throttle
        this._lastStreamTime = 0;

        // Bind event handlers
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onMouseLeave = this.onMouseLeave.bind(this);
    }

    init() {
        console.log('[ToolManager] Initialized.');
        
        // Attach pointer events to the canvas
        this.canvas.addEventListener('mousedown', this.onMouseDown);
        this.canvas.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
        this.canvas.addEventListener('mouseleave', this.onMouseLeave);
    }

    /**
     * Translates a MouseEvent into the 1920x1080 logical canvas space.
     * @param {MouseEvent} e 
     * @returns {{x: number, y: number}}
     */
    getLogicalCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        
        // Calculate scale factors
        const scaleX = 1920 / rect.width;
        const scaleY = 1080 / rect.height;

        // Apply scale to the mouse offset
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;

        // Return rounded integers
        return { x: Math.round(x), y: Math.round(y) };
    }

    onMouseDown(e) {
        // Only trigger on primary click (left button)
        if (e.button !== 0) return;
        
        const { x, y } = this.getLogicalCoordinates(e);

        if (window.AppState.activeTool === 'select') {
            this._handleSelectMouseDown(x, y);
            return;
        }

        this.isDrawing = true;

        if (window.AppState.activeTool === 'text') {
            e.preventDefault(); // Prevent default mousedown from instantly blurring the textarea
            this.isDrawing = false; // text doesn't use drag events
            this.openTextEditor(x, y);
            return;
        }

        // Initialize the preview object based on the active tool
        this.activePreview = {
            obj_type: window.AppState.activeTool,
            color: window.AppState.strokeColor,
            stroke_width: window.AppState.strokeEnabled ? window.AppState.strokeWidth : 0,
            startX: x,
            startY: y,
            properties: {}
        };

        if (this.activePreview.obj_type === 'pencil') {
            this.activePreview.properties.points = [[x, y]];
            this._lastStreamTime = performance.now();
        } else if (this.activePreview.obj_type === 'image_placement') {
            this.activePreview.properties.x = x;
            this.activePreview.properties.y = y;
            this.activePreview.properties.width = 0;
            this.activePreview.properties.height = 0;
            
            // Copy data from the global preview state
            this.activePreview.properties.base64 = window.AppState.previewImage.base64;
            this.activePreview.properties.naturalWidth = window.AppState.previewImage.naturalWidth;
            this.activePreview.properties.naturalHeight = window.AppState.previewImage.naturalHeight;
            this.activePreview.properties.original_filename = window.AppState.previewImage.original_filename;
        }
    }

    onMouseMove(e) {
        const { x, y } = this.getLogicalCoordinates(e);

        if (window.AppState.activeTool === 'select') {
            // Update hover cursor for handles
            this._updateSelectCursor(x, y);
            
            if (this.isDrawing || window.CollabCanvas.isResizing) {
                this._handleSelectMouseMove(x, y);
            }
            return;
        }

        if (!this.isDrawing) {
            // Hover preview for image placement
            if (window.AppState.activeTool === 'image_placement' && window.AppState.previewImage) {
                this.hoverPreview = { x, y };
            } else {
                this.hoverPreview = null;
            }
            return;
        }

        if (!this.activePreview) return;

        if (this.activePreview.obj_type === 'pencil') {
            this.activePreview.properties.points.push([x, y]);
            
            // Phase 2, Sprint 5: Stream Points
            const now = performance.now();
            if (now - this._lastStreamTime >= 30) {
                this._lastStreamTime = now;
                if (window.network && window.network.isIdentified) {
                    window.network.send({
                        type: 'stream_points',
                        obj_type: 'pencil',
                        color: this.activePreview.color,
                        stroke_width: this.activePreview.stroke_width,
                        points: this.activePreview.properties.points
                    });
                }
            }
        } else if (this.activePreview.obj_type === 'rectangle') {
            // Calculate width and height (can be negative during drag, so we normalize later or draw as is)
            this.activePreview.properties.x = Math.min(this.activePreview.startX, x);
            this.activePreview.properties.y = Math.min(this.activePreview.startY, y);
            this.activePreview.properties.width = Math.abs(x - this.activePreview.startX);
            this.activePreview.properties.height = Math.abs(y - this.activePreview.startY);
        } else if (this.activePreview.obj_type === 'image_placement') {
            const dragWidth = x - this.activePreview.startX;
            const dragHeight = y - this.activePreview.startY;

            // Preserve aspect ratio based on natural dimensions
            const naturalW = this.activePreview.properties.naturalWidth;
            const naturalH = this.activePreview.properties.naturalHeight;
            const aspect = naturalW / naturalH;

            // Use the largest drag dimension to dictate the bounding box
            let finalW = Math.abs(dragWidth);
            let finalH = finalW / aspect;
            
            if (Math.abs(dragHeight) > finalH) {
                finalH = Math.abs(dragHeight);
                finalW = finalH * aspect;
            }

            this.activePreview.properties.width = Math.round(finalW);
            this.activePreview.properties.height = Math.round(finalH);
            
            // Allow dragging in any direction
            this.activePreview.properties.x = dragWidth < 0 ? this.activePreview.startX - Math.round(finalW) : this.activePreview.startX;
            this.activePreview.properties.y = dragHeight < 0 ? this.activePreview.startY - Math.round(finalH) : this.activePreview.startY;
        } else if (this.activePreview.obj_type === 'circle') {
            const dx = x - this.activePreview.startX;
            const dy = y - this.activePreview.startY;
            this.activePreview.properties.cx = this.activePreview.startX;
            this.activePreview.properties.cy = this.activePreview.startY;
            this.activePreview.properties.radius = Math.round(Math.sqrt(dx * dx + dy * dy));
        } else if (this.activePreview.obj_type === 'line' || this.activePreview.obj_type === 'arrow') {
            this.activePreview.properties.x1 = this.activePreview.startX;
            this.activePreview.properties.y1 = this.activePreview.startY;
            this.activePreview.properties.x2 = x;
            this.activePreview.properties.y2 = y;
        } else if (this.activePreview.obj_type === 'heart') {
            const dx = x - this.activePreview.startX;
            const dy = y - this.activePreview.startY;
            this.activePreview.properties.cx = this.activePreview.startX;
            this.activePreview.properties.cy = this.activePreview.startY;
            this.activePreview.properties.size = Math.round(Math.sqrt(dx * dx + dy * dy));
        }
    }

    onMouseUp(e) {
        if (window.AppState.activeTool === 'select' && (this.isDrawing || window.CollabCanvas.isResizing)) {
            this._handleSelectMouseUp(e);
            return;
        }

        if (!this.isDrawing) return;
        this.isDrawing = false;
        
        this.finishStroke();
    }

    onMouseLeave(e) {
        // If they drag outside the canvas, we can either stop or keep drawing.
        // We'll finish the stroke if they leave.
        if (window.AppState.activeTool === 'select' && (this.isDrawing || window.CollabCanvas.isResizing)) {
            this._handleSelectMouseUp(e);
            return;
        }

        if (this.isDrawing) {
            this.isDrawing = false;
            this.finishStroke();
        }
    }

    // --- Select Tool Implementation (Phase 2, Sprint 3) ---

    _handleSelectMouseDown(x, y) {
        const canvasRenderer = window.CollabCanvas;
        const selectedObj = canvasRenderer.getSelectedObject();

        if (selectedObj) {
            // Check if we hit a handle
            const handle = window.geometry.hitTestHandle(selectedObj, x, y, canvasRenderer.ctx);
            if (handle) {
                canvasRenderer.isResizing = true;
                canvasRenderer.selectedHandle = handle;
                // Deep copy the state for computing delta later and for Undo/Redo
                canvasRenderer.resizeStart = {
                    mx: x,
                    my: y,
                    snapshot: JSON.parse(JSON.stringify(selectedObj))
                };
                return;
            }
            
            // Check if we hit the selected object body (pass isSelected = true)
            if (window.geometry.hitTest(selectedObj, x, y, canvasRenderer.ctx, 5, true)) {
                this.isDrawing = true; // Use isDrawing as "isDragging"
                canvasRenderer.resizeStart = {
                    mx: x,
                    my: y,
                    snapshot: JSON.parse(JSON.stringify(selectedObj))
                };
                return;
            }
        }

        // Iterate objects in reverse z-order to find hit
        const sortedObjects = Array.from(canvasRenderer.objects.values()).sort((a, b) => {
            if (a.z_index !== b.z_index) return b.z_index - a.z_index; // Reverse z-index
            return (b.seq || 0) - (a.seq || 0);
        });

        let foundHit = false;
        for (const obj of sortedObjects) {
            if (!obj.is_deleted && window.geometry.hitTest(obj, x, y, canvasRenderer.ctx)) {
                canvasRenderer.selectObject(obj.obj_id);
                foundHit = true;
                
                // Allow dragging immediately upon selection
                this.isDrawing = true;
                canvasRenderer.resizeStart = {
                    mx: x,
                    my: y,
                    snapshot: JSON.parse(JSON.stringify(obj))
                };

                // Sync UI state using helper
                this._syncUIForObject(obj);

                break;
            }
        }

        if (!foundHit) {
            canvasRenderer.clearSelection();
            
            // Reset UI visibility to default for the active tool
            if (typeof setActiveTool === 'function' && window.AppState) {
                setActiveTool(window.AppState.activeTool);
            }
        }
    }

    _handleSelectMouseMove(x, y) {
        const canvasRenderer = window.CollabCanvas;
        const selectedObj = canvasRenderer.getSelectedObject();
        if (!selectedObj || !canvasRenderer.resizeStart) return;

        const dx = x - canvasRenderer.resizeStart.mx;
        const dy = y - canvasRenderer.resizeStart.my;

        if (canvasRenderer.isResizing) {
            // Resize
            const handle = canvasRenderer.selectedHandle;
            const newProps = window.geometry.computeResize(selectedObj, handle, canvasRenderer.resizeStart.snapshot, dx, dy, canvasRenderer.ctx);
            // Apply locally for preview
            selectedObj.properties = newProps;
        } else if (this.isDrawing) {
            // Drag
            const newProps = window.geometry.computeMove(selectedObj, canvasRenderer.resizeStart.snapshot, dx, dy);
            // Apply locally for preview
            selectedObj.properties = newProps;
        }
    }

    _handleSelectMouseUp(e) {
        const canvasRenderer = window.CollabCanvas;
        
        if (canvasRenderer.isResizing || this.isDrawing) {
            const selectedObj = canvasRenderer.getSelectedObject();
            if (selectedObj && canvasRenderer.resizeStart) {
                // Determine if there was an actual change
                const dx = canvasRenderer.resizeStart.mx - this.getLogicalCoordinates(e).x;
                const dy = canvasRenderer.resizeStart.my - this.getLogicalCoordinates(e).y;
                
                // If dragged/resized, send op: modify
                const oldSnapshot = canvasRenderer.resizeStart.snapshot;
                
                // We send only properties that changed.
                const changes = {
                    properties: selectedObj.properties
                };

                const modifyOp = {
                    type: 'op',
                    op: 'modify',
                    obj_id: selectedObj.obj_id,
                    changes: changes
                };

                if (window.network && window.network.isIdentified) {
                    window.network.send(modifyOp);
                    if (window.UndoRedoManager) {
                        // UndoRedoManager expects the old values for undo and new for redo
                        const undoOp = {
                            type: 'op',
                            op: 'modify',
                            obj_id: selectedObj.obj_id,
                            changes: changes,
                            old_values: { properties: oldSnapshot.properties }
                        };
                        window.UndoRedoManager.pushAction(undoOp);
                    }
                }
            }
        }

        this.isDrawing = false;
        canvasRenderer.isResizing = false;
        canvasRenderer.resizeStart = null;
        canvasRenderer.selectedHandle = null;
    }

    _updateSelectCursor(x, y) {
        const canvasRenderer = window.CollabCanvas;
        const selectedObj = canvasRenderer.getSelectedObject();
        if (!selectedObj) {
            this.canvas.style.cursor = 'default';
            return;
        }

        const handle = window.geometry.hitTestHandle(selectedObj, x, y, canvasRenderer.ctx);
        if (handle) {
            if (handle === 'nw' || handle === 'se') this.canvas.style.cursor = 'nwse-resize';
            else if (handle === 'ne' || handle === 'sw') this.canvas.style.cursor = 'nesw-resize';
            else if (handle === 'n' || handle === 's') this.canvas.style.cursor = 'ns-resize';
            else if (handle === 'e' || handle === 'w') this.canvas.style.cursor = 'ew-resize';
            else if (handle === 'p1' || handle === 'p2') this.canvas.style.cursor = 'crosshair';
        } else if (window.geometry.hitTest(selectedObj, x, y, canvasRenderer.ctx)) {
            this.canvas.style.cursor = 'move';
        } else {
            this.canvas.style.cursor = 'default';
        }
    }

    _syncUIForObject(obj) {
        const strokeColorInput = document.getElementById('tool-stroke-color');
        const fillColorInput = document.getElementById('tool-fill-color');
        const strokeWidthInput = document.getElementById('tool-stroke-width');
        const fillToggleBtn = document.getElementById('tool-fill-toggle');
        const strokeToggleBtn = document.getElementById('tool-stroke-toggle');
        
        const strokeControls = document.getElementById('stroke-controls');
        const strokeSeparator = document.getElementById('stroke-separator');
        const fillControls = document.getElementById('fill-controls');
        const fillSeparator = document.getElementById('fill-separator');

        if (obj.obj_type === 'image') {
            if (strokeControls) strokeControls.style.display = 'none';
            if (strokeSeparator) strokeSeparator.style.display = 'none';
            if (fillControls) fillControls.style.display = 'none';
            if (fillSeparator) fillSeparator.style.display = 'none';
            if (strokeWidthInput) strokeWidthInput.style.display = 'none';
            const fontSizeInput = document.getElementById('tool-font-size');
            if (fontSizeInput) fontSizeInput.style.display = 'none';
            return;
        } else {
            if (strokeControls) strokeControls.style.display = 'flex';
            if (strokeSeparator) strokeSeparator.style.display = 'block';
        }

        if (strokeColorInput && obj.color) {
            strokeColorInput.value = obj.color;
            window.AppState.strokeColor = obj.color;
            const strokeColorSwatch = document.getElementById('tool-stroke-swatch');
            if (strokeColorSwatch) strokeColorSwatch.style.background = obj.color;
        }
        
        if (fillColorInput && obj.properties.fill_color) {
            fillColorInput.value = obj.properties.fill_color;
            window.AppState.fillColor = obj.properties.fill_color;
            const fillColorSwatch = document.getElementById('tool-fill-swatch');
            if (fillColorSwatch) fillColorSwatch.style.background = obj.properties.fill_color;
        }
        
        if (strokeWidthInput && obj.stroke_width !== undefined) {
            strokeWidthInput.value = obj.stroke_width === 0 ? window.AppState.strokeWidth : obj.stroke_width;
            if (obj.stroke_width > 0) window.AppState.strokeWidth = obj.stroke_width;
        }
        
        if (obj.obj_type === 'text') {
            const fontSizeInput = document.getElementById('tool-font-size');
            if (fontSizeInput && obj.properties.font_size) {
                fontSizeInput.style.display = 'inline-block';
                fontSizeInput.value = obj.properties.font_size;
                window.AppState.fontSize = obj.properties.font_size;
            }
            if (strokeWidthInput) strokeWidthInput.style.display = 'none';
        } else {
            const fontSizeInput = document.getElementById('tool-font-size');
            if (fontSizeInput) fontSizeInput.style.display = 'none';
            if (strokeWidthInput) strokeWidthInput.style.display = 'inline-block';
        }

        const noFillTools = ['pencil', 'line', 'arrow', 'text'];

        if (noFillTools.includes(obj.obj_type)) {
            if (fillControls) fillControls.style.display = 'none';
            if (fillSeparator) fillSeparator.style.display = 'none';
        } else {
            if (fillControls) fillControls.style.display = 'flex';
            if (fillSeparator) fillSeparator.style.display = 'block';
            if (fillToggleBtn) {
                const hasFill = !!obj.properties.fill_color;
                window.AppState.fillEnabled = hasFill;
                fillToggleBtn.classList.toggle('active', hasFill);
            }
        }
        
        const noStrokeToggleTools = ['pencil', 'line', 'arrow', 'text'];
        if (noStrokeToggleTools.includes(obj.obj_type)) {
            if (strokeToggleBtn) strokeToggleBtn.style.display = 'none';
        } else {
            if (strokeToggleBtn) {
                strokeToggleBtn.style.display = 'flex';
                const hasStroke = obj.stroke_width > 0;
                window.AppState.strokeEnabled = hasStroke;
                strokeToggleBtn.classList.toggle('active', hasStroke);
            }
        }
    }

    /**
     * Finalizes the current preview stroke, constructs the payload,
     * optimistically adds it to the local canvas, and sends it over the network.
     */
    finishStroke() {
        if (!this.activePreview) return;

        // Skip invalid strokes (e.g., pencil with only 1 point, rect with 0 width)
        if (this.activePreview.obj_type === 'pencil') {
            if (this.activePreview.properties.points.length < 2) {
                this.activePreview = null;
                return;
            }
        } else if (this.activePreview.obj_type === 'rectangle') {
            if (!this.activePreview.properties.width || !this.activePreview.properties.height) {
                this.activePreview = null;
                return;
            }
            this.activePreview.properties.fill_color = window.AppState.fillEnabled ? window.AppState.fillColor : null;
        } else if (this.activePreview.obj_type === 'image_placement') {
            // If just clicked (width == 0), place at default size (bounded to 400x400)
            if (this.activePreview.properties.width === 0 || this.activePreview.properties.height === 0) {
                const maxPlaceDim = 400;
                let w = this.activePreview.properties.naturalWidth;
                let h = this.activePreview.properties.naturalHeight;
                if (w > maxPlaceDim || h > maxPlaceDim) {
                    const scale = Math.min(maxPlaceDim / w, maxPlaceDim / h);
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                }
                // Center around the click, rounding to prevent backend Pydantic validation errors
                this.activePreview.properties.x = Math.round(this.activePreview.startX - w / 2);
                this.activePreview.properties.y = Math.round(this.activePreview.startY - h / 2);
                this.activePreview.properties.width = Math.round(w);
                this.activePreview.properties.height = Math.round(h);
            }

            // Convert to a standard 'image' object for network and renderer
            this.activePreview.obj_type = 'image';
            this.activePreview.color = '#000000'; // Must be valid hex to pass Pydantic validation
            
            // Fix payload: provide 'image_data' (which backend saves and strips) 
            // AND keep 'base64' (which bypasses stripping and goes to other clients)
            this.activePreview.properties.image_data = this.activePreview.properties.base64;
            
            // Clean up temporary natural properties
            delete this.activePreview.properties.naturalWidth;
            delete this.activePreview.properties.naturalHeight;

            window.AppState.previewImage = null;
            this.activePreview.properties.fill_color = window.AppState.fillEnabled ? window.AppState.fillColor : null;
        } else if (this.activePreview.obj_type === 'circle') {
            if (!this.activePreview.properties.radius || this.activePreview.properties.radius < 2) {
                this.activePreview = null;
                return;
            }
            this.activePreview.properties.fill_color = window.AppState.fillEnabled ? window.AppState.fillColor : null;
        } else if (this.activePreview.obj_type === 'line' || this.activePreview.obj_type === 'arrow') {
            const dx = this.activePreview.properties.x2 - this.activePreview.properties.x1;
            const dy = this.activePreview.properties.y2 - this.activePreview.properties.y1;
            if (Math.sqrt(dx * dx + dy * dy) < 2) {
                this.activePreview = null;
                return;
            }
        } else if (this.activePreview.obj_type === 'heart') {
            if (!this.activePreview.properties.size || this.activePreview.properties.size < 5) {
                this.activePreview = null;
                return;
            }
            this.activePreview.properties.fill_color = window.AppState.fillEnabled ? window.AppState.fillColor : null;
        } else {
            // For other tools not yet implemented, just abort
            this.activePreview = null;
            return;
        }

        // Construct the full payload required by API_CONTRACT.md §9
        const payload = {
            obj_type: this.activePreview.obj_type,
            z_index: window.CollabCanvas.objects.size, // Put on top
            color: this.activePreview.color,
            stroke_width: this.activePreview.stroke_width,
            properties: this.activePreview.properties
        };

        // 1. Optimistic Update (Local Render)
        // Give it a temporary UUID until the server acks it
        // Use a fallback for crypto.randomUUID() as Brave Shields may block it
        const generateUUID = () => {
            try {
                if (window.crypto && window.crypto.randomUUID) {
                    return window.crypto.randomUUID();
                }
            } catch (e) {
                // Ignore and use fallback (Brave Shields can throw on call)
            }
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        };
        
        const tempId = 'temp-' + generateUUID();
        const optimisticObj = {
            ...payload,
            obj_id: tempId,
            created_by: window.AppState.userId || 'local',
            created_at: new Date().toISOString()
        };
        
        window.CollabCanvas.addOptimisticObject(optimisticObj);

        // 2. Network Send
        if (window.network && window.network.isIdentified) {
            // Phase 2, Sprint 5: Stream End
            if (this.activePreview.obj_type === 'pencil') {
                window.network.send({ type: 'stream_end' });
            }

            const addOp = {
                type: 'op',
                op: 'add',
                object: optimisticObj
            };
            window.network.send(addOp);
            
            // Record locally for undo/redo
            if (window.UndoRedoManager) {
                window.UndoRedoManager.pushAction(addOp);
            }
        } else {
            console.warn('[ToolManager] Not connected to room. Stroke drawn locally only.');
        }

        // Clear preview
        this.activePreview = null;
        
        // Auto-select newly created object (unless pencil)
        if (optimisticObj.obj_type !== 'pencil') {
            window.AppState.activeTool = 'select';
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            const selectBtn = document.getElementById('tool-select');
            if(selectBtn) selectBtn.classList.add('active');
            document.getElementById('canvas-container').style.cursor = 'default';
            
            window.CollabCanvas.selectObject(optimisticObj.obj_id);
            this._syncUIForObject(optimisticObj);
        }
    }

    /**
     * Opens a floating textarea over the canvas for text input.
     * @param {number} logicalX 
     * @param {number} logicalY 
     */
    openTextEditor(logicalX, logicalY) {
        // Prevent opening multiple text editors
        if (this.activeTextEditor) {
            this.activeTextEditor.focus();
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const scaleX = rect.width / 1920;
        const scaleY = rect.height / 1080;

        const screenX = rect.left + (logicalX * scaleX);
        const screenY = rect.top + (logicalY * scaleY);

        const textarea = document.createElement('textarea');
        this.activeTextEditor = textarea;

        // Base styles for floating editor
        textarea.style.position = 'absolute';
        textarea.style.left = `${screenX}px`;
        textarea.style.top = `${screenY}px`;
        textarea.style.minWidth = '100px';
        textarea.style.minHeight = `${window.AppState.fontSize * scaleY}px`;
        textarea.style.background = 'transparent';
        textarea.style.outline = 'none';
        textarea.style.border = '1px dashed var(--color-primary)';
        textarea.style.color = window.AppState.strokeColor;
        textarea.style.fontFamily = 'Inter, system-ui, sans-serif';
        textarea.style.fontSize = `${window.AppState.fontSize * scaleY}px`;
        textarea.style.lineHeight = '1.2';
        textarea.style.resize = 'none';
        textarea.style.overflow = 'hidden';
        textarea.style.whiteSpace = 'pre-wrap';
        textarea.style.zIndex = '1000'; // above everything

        // Auto-expand as user types
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        });

        const commitText = () => {
            if (!this.activeTextEditor) return;
            // Prevent double execution if blur is fired while removing
            const currentEditor = this.activeTextEditor;
            this.activeTextEditor = null;

            const content = currentEditor.value.trim();
            
            if (content.length > 0) {
                // Generate uuid
                const generateUUID = () => {
                    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
                    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                        const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                    });
                };
                
                const addOp = {
                    type: 'op',
                    op: 'add',
                    object: {
                        obj_type: 'text',
                        z_index: window.CollabCanvas.objects.size,
                        color: window.AppState.strokeColor,
                        stroke_width: 0,
                        properties: {
                            x: logicalX,
                            y: logicalY,
                            content: content,
                            font_size: window.AppState.fontSize
                        },
                        obj_id: 'temp-' + generateUUID(),
                        created_by: window.AppState.userId || 'local',
                        created_at: new Date().toISOString()
                    }
                };

                window.CollabCanvas.addOptimisticObject(addOp.object);

                if (window.network && window.network.isIdentified) {
                    window.network.send(addOp);
                    if (window.UndoRedoManager) {
                        window.UndoRedoManager.pushAction(addOp);
                    }
                }
                
                // Auto-select text
                window.AppState.activeTool = 'select';
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                const selectBtn = document.getElementById('tool-select');
                if(selectBtn) selectBtn.classList.add('active');
                document.getElementById('canvas-container').style.cursor = 'default';
                
                window.CollabCanvas.selectObject(addOp.object.obj_id);
                this._syncUIForObject(addOp.object);
            }

            // Cleanup
            if (currentEditor.parentNode) {
                currentEditor.parentNode.removeChild(currentEditor);
            }
        };

        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                // Cancel
                if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
                this.activeTextEditor = null;
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                // Ctrl+Enter to commit
                e.preventDefault();
                commitText();
            }
        };

        textarea.addEventListener('blur', commitText);
        textarea.addEventListener('keydown', handleKeydown);

        document.body.appendChild(textarea);
        textarea.focus();
    }


    /**
     * Called by CanvasRenderer every frame.
     * Draws the active stroke on top of the committed canvas state.
     * @param {CanvasRenderingContext2D} ctx 
     */
    renderPreview(ctx) {
        // Render hover state for image placement (before click)
        if (!this.isDrawing && window.AppState.activeTool === 'image_placement' && this.hoverPreview && window.AppState.previewImage) {
            const maxPlaceDim = 400;
            let w = window.AppState.previewImage.naturalWidth;
            let h = window.AppState.previewImage.naturalHeight;
            if (w > maxPlaceDim || h > maxPlaceDim) {
                const scale = Math.min(maxPlaceDim / w, maxPlaceDim / h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
            }
            const px = this.hoverPreview.x - w/2;
            const py = this.hoverPreview.y - h/2;

            ctx.globalAlpha = 0.5;
            
            let img = window.CollabCanvas.imageCache.get('preview_hover');
            if (!img || img.src !== window.AppState.previewImage.base64) {
                img = new Image();
                img.src = window.AppState.previewImage.base64;
                window.CollabCanvas.imageCache.set('preview_hover', img);
            }
            
            if (img.complete && img.naturalWidth > 0) {
                ctx.drawImage(img, px, py, w, h);
            }
            ctx.globalAlpha = 1.0;
            return;
        }

        if (!this.isDrawing || !this.activePreview) return;

        const { obj_type, color, stroke_width, properties } = this.activePreview;

        ctx.strokeStyle = color;
        ctx.lineWidth = stroke_width;
        ctx.fillStyle = 'transparent';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();

        if (obj_type === 'pencil' && properties.points) {
            ctx.moveTo(properties.points[0][0], properties.points[0][1]);
            for (let i = 1; i < properties.points.length; i++) {
                ctx.lineTo(properties.points[i][0], properties.points[i][1]);
            }
            ctx.stroke();
        } 
        else if (obj_type === 'rectangle' && properties.width && properties.height) {
            if (window.AppState.fillEnabled) {
                ctx.fillStyle = window.AppState.fillColor;
                ctx.fillRect(properties.x, properties.y, properties.width, properties.height);
            }
            if (stroke_width > 0) ctx.strokeRect(properties.x, properties.y, properties.width, properties.height);
        }
        else if (obj_type === 'circle' && properties.radius) {
            ctx.arc(properties.cx, properties.cy, properties.radius, 0, Math.PI * 2);
            if (window.AppState.fillEnabled) {
                ctx.fillStyle = window.AppState.fillColor;
                ctx.fill();
            }
            if (stroke_width > 0) ctx.stroke();
        }
        else if (obj_type === 'line' && properties.x2 !== undefined) {
            ctx.moveTo(properties.x1, properties.y1);
            ctx.lineTo(properties.x2, properties.y2);
            ctx.stroke();
        }
        else if (obj_type === 'arrow' && properties.x2 !== undefined) {
            const { x1, y1, x2, y2 } = properties;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            const headLen = Math.max(10, stroke_width * 3);
            const angle = Math.atan2(y2 - y1, x2 - x1);
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
            ctx.stroke();
        }
        else if (obj_type === 'heart' && properties.size) {
            const { cx: hx, cy: hy, size } = properties;
            const s = size / 2;
            ctx.moveTo(hx, hy + s * 0.4);
            ctx.bezierCurveTo(hx - s * 1.2, hy - s * 0.6, hx - s * 0.6, hy - s * 1.4, hx, hy - s * 0.6);
            ctx.bezierCurveTo(hx + s * 0.6, hy - s * 1.4, hx + s * 1.2, hy - s * 0.6, hx, hy + s * 0.4);
            ctx.closePath();
            if (window.AppState.fillEnabled) {
                ctx.fillStyle = window.AppState.fillColor;
                ctx.fill();
            }
            if (stroke_width > 0) ctx.stroke();
        }
        else if (obj_type === 'image_placement') {
            if (properties.width > 0 && properties.height > 0) {
                let img = window.CollabCanvas.imageCache.get('preview_drag');
                if (!img || img.src !== properties.base64) {
                    img = new Image();
                    img.src = properties.base64;
                    window.CollabCanvas.imageCache.set('preview_drag', img);
                }
                if (img.complete && img.naturalWidth > 0) {
                    ctx.drawImage(img, properties.x, properties.y, properties.width, properties.height);
                }
                
                // Draw a blue bounding box like Figma
                ctx.strokeStyle = '#0d99ff';
                ctx.lineWidth = 2;
                ctx.strokeRect(properties.x, properties.y, properties.width, properties.height);
            }
        }
    }
}

// Export as global
window.ToolManager = new ToolManagerClass();

// =============================================================================
// Day 10: Image Upload Handler
// =============================================================================
// Handles file selection from the hidden <input type="file">, applies
// client-side compression if the image exceeds 2MB, reads it as base64,
// and dispatches it as an optimistic 'image' object.
// =============================================================================

(function initImageUpload() {
    const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB limit
    const MAX_DIMENSION = 1920; // Cap image dimensions to canvas logical size
    const COMPRESSION_QUALITY = 0.7; // JPEG quality for compression

    const uploadInput = document.getElementById('image-upload-input');
    if (!uploadInput) return;

    uploadInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Reset the input so the same file can be re-selected
        uploadInput.value = '';

        // Validate file type
        if (!file.type.startsWith('image/')) {
            alert('Please select a valid image file (PNG, JPEG, or WebP).');
            return;
        }

        console.log(`[ImageUpload] Selected file: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);

        try {
            const base64 = await processImage(file);
            prepareImagePlacement(base64, file.name);
        } catch (err) {
            console.error('[ImageUpload] Failed to process image:', err);
            alert('Failed to process image. Please try a different file.');
        }
    });

    /**
     * Reads and optionally compresses an image file to stay within 2MB base64.
     * @param {File} file
     * @returns {Promise<string>} base64 data URL
     */
    function processImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('FileReader error'));
            reader.onload = () => {
                const dataUrl = reader.result;

                // If the raw file is small enough, use it directly
                if (file.size <= MAX_FILE_SIZE) {
                    console.log('[ImageUpload] File within 2MB limit, using original.');
                    resolve(dataUrl);
                    return;
                }

                // File exceeds 2MB — compress via offscreen canvas
                console.log('[ImageUpload] File exceeds 2MB, compressing...');
                compressImage(dataUrl).then(resolve).catch(reject);
            };
            reader.readAsDataURL(file);
        });
    }

    /**
     * Compresses an image data URL by drawing it to an offscreen canvas
     * and re-exporting as JPEG at reduced quality/dimensions.
     * @param {string} dataUrl
     * @returns {Promise<string>} compressed base64 data URL
     */
    function compressImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onerror = () => reject(new Error('Image decode error'));
            img.onload = () => {
                // Scale down if either dimension exceeds the maximum
                let { width, height } = img;
                if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                    const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
                    width = Math.round(width * scale);
                    height = Math.round(height * scale);
                }

                const offscreen = document.createElement('canvas');
                offscreen.width = width;
                offscreen.height = height;
                const ctx = offscreen.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Try JPEG first for maximum compression
                let compressed = offscreen.toDataURL('image/jpeg', COMPRESSION_QUALITY);

                // If still too large, progressively reduce quality
                let quality = COMPRESSION_QUALITY;
                while (compressed.length > MAX_FILE_SIZE * 1.37 && quality > 0.1) {
                    quality -= 0.1;
                    compressed = offscreen.toDataURL('image/jpeg', quality);
                }

                console.log(`[ImageUpload] Compressed to ${(compressed.length / 1024).toFixed(1)}KB (quality=${quality.toFixed(1)})`);
                resolve(compressed);
            };
            img.src = dataUrl;
        });
    }

    /**
     * Prepares the UI and state for the Figma-like placement interaction.
     * @param {string} base64
     * @param {string} filename
     */
    function prepareImagePlacement(base64, filename) {
        const img = new Image();
        img.onload = () => {
            // Set up global preview state
            window.AppState = window.AppState || {};
            window.AppState.previewImage = {
                base64: base64,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                original_filename: filename
            };

            // Switch tool mode
            window.AppState.activeTool = 'image_placement';
            
            // Update UI buttons
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            const imageBtn = document.getElementById('tool-image');
            if (imageBtn) imageBtn.classList.add('active');
            
            // Change cursor to crosshair for placement
            const container = document.getElementById('canvas-container');
            if (container) container.style.cursor = 'crosshair';

            console.log(`[ImageUpload] Entered placement mode for ${filename}`);
        };
        img.src = base64;
    }
})();
