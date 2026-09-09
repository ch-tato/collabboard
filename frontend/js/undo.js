/**
 * Day 8 - Undo/Redo Manager (M3)
 * Manages the client-side history stack and computes inverse operations.
 */
class UndoRedoManagerClass {
    constructor() {
        this.undoStack = [];
        this.redoStack = [];
        this.maxDepth = 50;
    }

    /**
     * Records a local operation to the undo stack and clears redo stack.
     * @param {Object} op - The operation payload (e.g. { op: 'add', object: {...} })
     */
    pushAction(op) {
        // Deep copy the object to prevent reference mutations
        const action = JSON.parse(JSON.stringify(op));
        this.undoStack.push(action);
        if (this.undoStack.length > this.maxDepth) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.updateStatus();
    }

    /**
     * Updates an object ID in the stacks (e.g., when a temporary ID is acked by the server).
     * @param {string} oldId
     * @param {string} newId
     */
    updateObjectId(oldId, newId) {
        const updateStack = (stack) => {
            for (let i = 0; i < stack.length; i++) {
                let action = stack[i];
                if (action.op === 'add') {
                    if (action.object && action.object.obj_id === oldId) {
                        action.object.obj_id = newId;
                    }
                } else if (action.op === 'delete') {
                    if (action.obj_id === oldId) {
                        action.obj_id = newId;
                    }
                    if (action.object && action.object.obj_id === oldId) {
                        action.object.obj_id = newId;
                    }
                } else if (action.op === 'modify') {
                    if (action.obj_id === oldId) {
                        action.obj_id = newId;
                    }
                }
            }
        };
        updateStack(this.undoStack);
        updateStack(this.redoStack);
    }

    /**
     * Performs an undo operation.
     */
    undo() {
        if (this.undoStack.length === 0) return;

        const action = this.undoStack.pop();
        this.redoStack.push(action);
        
        const inverseOp = this._computeInverse(action);
        this._dispatch(inverseOp);
        this.updateStatus();
    }

    /**
     * Performs a redo operation.
     */
    redo() {
        if (this.redoStack.length === 0) return;

        const action = this.redoStack.pop();
        this.undoStack.push(action);
        
        // Redo is just re-applying the original action
        this._dispatch(action);
        this.updateStatus();
    }

    /**
     * Computes the inverse of an operation.
     * @param {Object} action 
     * @returns {Object}
     */
    _computeInverse(action) {
        if (action.op === 'add') {
            return {
                type: 'op',
                op: 'delete',
                obj_id: action.object.obj_id
            };
        } else if (action.op === 'delete') {
            return {
                type: 'op',
                op: 'add',
                object: action.object // We must store the full object in the delete action when pushed
            };
        } else if (action.op === 'modify') {
            return {
                type: 'op',
                op: 'modify',
                obj_id: action.obj_id,
                changes: action.old_values // We must store the old values when a modify is pushed
            };
        }
    }

    /**
     * Generates a UUID for temporary optimistic IDs.
     */
    _generateUUID() {
        try {
            if (window.crypto && window.crypto.randomUUID) {
                return window.crypto.randomUUID();
            }
        } catch (e) {}
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Sends the operation to the server and applies it optimistically locally.
     * @param {Object} action 
     */
    _dispatch(action) {
        // Prepare base payload
        const payload = {
            type: 'op',
            op: action.op
        };
        
        if (action.op === 'add') {
            const oldId = action.object.obj_id;
            const tempId = 'temp-' + this._generateUUID();
            
            // We must give it a fresh temporary ID so the server processes it as a new insert
            // and so the local canvas queues it in pendingAdds correctly.
            action.object.obj_id = tempId;
            
            // Update all references in history stacks to use the new tempId
            // This ensures subsequent undo/redo actions target the right object!
            if (oldId && oldId !== tempId) {
                this.updateObjectId(oldId, tempId);
            }
            
            payload.object = action.object;
            // Optimistic update
            window.CollabCanvas?.addOptimisticObject(action.object);
        } else if (action.op === 'delete') {
            payload.obj_id = action.obj_id;
            // Optimistic update
            window.CollabCanvas?.removeOptimisticObject(action.obj_id);
        } else if (action.op === 'modify') {
            payload.obj_id = action.obj_id;
            payload.changes = action.changes;
            // Optimistic update
            window.CollabCanvas?.modifyOptimisticObject(action.obj_id, action.changes);
        }

        if (window.network && window.network.isIdentified) {
            window.network.send(payload);
        }
    }

    /**
     * Optionally update a status indicator in the UI (e.g. for debugging/feedback).
     */
    updateStatus() {
        console.log(`[UndoRedo] Undo Stack: ${this.undoStack.length}, Redo Stack: ${this.redoStack.length}`);
    }
}

// Export as global
window.UndoRedoManager = new UndoRedoManagerClass();
