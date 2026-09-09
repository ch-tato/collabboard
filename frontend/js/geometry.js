// =============================================================================
// CollabBoard — Geometry Utilities
// =============================================================================
// Owner : M2 (Frontend Engineer)
// Sprint: Phase 2, Sprint 3
//
// Pure math utility functions for bounding boxes, hit detection, and resizing.
// =============================================================================

'use strict';

const geometry = {
    /**
     * Compute bounding box for any canvas object.
     * @returns {{ x: number, y: number, width: number, height: number }} in logical 1920x1080 space
     */
    getBoundingBox(obj, ctx = null) {
        const { obj_type, properties, stroke_width } = obj;
        const sw = (stroke_width || 0) / 2;
        
        switch (obj_type) {
            case 'rectangle':
            case 'image':
                return {
                    x: properties.x - sw,
                    y: properties.y - sw,
                    width: properties.width + 2 * sw,
                    height: properties.height + 2 * sw
                };
            case 'circle':
                return {
                    x: properties.cx - properties.radius - sw,
                    y: properties.cy - properties.radius - sw,
                    width: properties.radius * 2 + 2 * sw,
                    height: properties.radius * 2 + 2 * sw
                };
            case 'heart': {
                // Exact bounding box calculated from cubic bezier extrema
                const s = properties.size / 2;
                return {
                    x: properties.cx - s * 0.693 - sw,
                    y: properties.cy - s * 0.927 - sw,
                    width: s * 1.386 + 2 * sw,
                    height: s * 1.327 + 2 * sw
                };
            }
            case 'line':
            case 'arrow':
                return {
                    x: Math.min(properties.x1, properties.x2) - sw,
                    y: Math.min(properties.y1, properties.y2) - sw,
                    width: Math.abs(properties.x2 - properties.x1) + 2 * sw,
                    height: Math.abs(properties.y2 - properties.y1) + 2 * sw
                };
            case 'pencil':
                if (!properties.points || properties.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const [px, py] of properties.points) {
                    minX = Math.min(minX, px);
                    minY = Math.min(minY, py);
                    maxX = Math.max(maxX, px);
                    maxY = Math.max(maxY, py);
                }
                return {
                    x: minX - sw,
                    y: minY - sw,
                    width: maxX - minX + 2 * sw,
                    height: maxY - minY + 2 * sw
                };
            case 'text': {
                const lines = (properties.content || '').split('\n');
                let maxW = 0;
                let actualTop = 0;
                let actualBottom = 0;

                if (ctx) {
                    ctx.save();
                    ctx.font = `${properties.font_size}px Inter, system-ui, sans-serif`;
                    ctx.textBaseline = 'top';
                    
                    let yOffset = 0;
                    for (let i = 0; i < lines.length; i++) {
                        const m = ctx.measureText(lines[i]);
                        maxW = Math.max(maxW, m.width);
                        
                        const ascent = m.actualBoundingBoxAscent !== undefined ? m.actualBoundingBoxAscent : 0;
                        const descent = m.actualBoundingBoxDescent !== undefined ? m.actualBoundingBoxDescent : (properties.font_size * 1.2);
                        
                        const lineTop = yOffset - ascent;
                        const lineBottom = yOffset + descent;
                        
                        if (i === 0) actualTop = lineTop;
                        actualBottom = lineBottom;
                        
                        yOffset += properties.font_size * 1.2;
                    }
                    ctx.restore();
                    
                    const pad = 4; // Padding to ensure handles don't obscure text
                    return {
                        x: properties.x - pad,
                        y: properties.y + actualTop - pad,
                        width: maxW + (pad * 2),
                        height: (actualBottom - actualTop) + (pad * 2)
                    };
                } else {
                    for (const line of lines) {
                        maxW = Math.max(maxW, line.length * (properties.font_size * 0.6));
                    }
                    return {
                        x: properties.x,
                        y: properties.y,
                        width: maxW || 10,
                        height: (properties.font_size * 1.2) * Math.max(1, lines.length)
                    };
                }
            }
            default:
                return { x: 0, y: 0, width: 0, height: 0 };
        }
    },

    /**
     * Point-to-line-segment distance.
     * Used for line, arrow, and pencil hit detection.
     */
    pointToSegmentDistance(px, py, x1, y1, x2, y2) {
        const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
        if (l2 === 0) return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
        let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
        t = Math.max(0, Math.min(1, t));
        const projX = x1 + t * (x2 - x1);
        const projY = y1 + t * (y2 - y1);
        return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
    },

    /**
     * Hit-test: is point (mx, my) inside the object?
     * @returns {boolean}
     */
    hitTest(obj, mx, my, ctx = null, tolerance = 5, isSelected = false) {
        const { obj_type, properties, stroke_width } = obj;
        const tol = tolerance + (stroke_width || 0) / 2;

        if (obj_type === 'rectangle') {
            const { x, y, width, height, fill_color } = properties;
            if (fill_color || isSelected) {
                return mx >= x && mx <= x + width && my >= y && my <= y + height;
            } else {
                // Stroke only
                const outX = mx >= x - tol && mx <= x + width + tol;
                const outY = my >= y - tol && my <= y + height + tol;
                const inX = mx >= x + tol && mx <= x + width - tol;
                const inY = my >= y + tol && my <= y + height - tol;
                return (outX && outY) && !(inX && inY);
            }
        }
        
        if (obj_type === 'circle') {
            const { cx, cy, radius, fill_color } = properties;
            const dist = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
            if (fill_color || isSelected) {
                return dist <= radius + tol;
            } else {
                return dist >= radius - tol && dist <= radius + tol;
            }
        }

        if (obj_type === 'line' || obj_type === 'arrow') {
            return this.pointToSegmentDistance(mx, my, properties.x1, properties.y1, properties.x2, properties.y2) <= tol;
        }

        if (obj_type === 'pencil') {
            const pts = properties.points;
            if (!pts || pts.length < 2) return false;
            for (let i = 0; i < pts.length - 1; i++) {
                if (this.pointToSegmentDistance(mx, my, pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) <= tol) return true;
            }
            return false;
        }

        if (obj_type === 'heart') {
            // Heart hit detection can use a bounding box approximation or an inner circle
            const dist = Math.sqrt((mx - properties.cx) ** 2 + (my - properties.cy) ** 2);
            if (properties.fill_color) {
                // Inner filled area circle approximation
                return dist <= properties.size * 0.35 + tol;
            } else {
                // Just check bounding box for simplicity if not filled
                const bbox = this.getBoundingBox(obj);
                return mx >= bbox.x && mx <= bbox.x + bbox.width && my >= bbox.y && my <= bbox.y + bbox.height;
            }
        }

        if (obj_type === 'image') {
            const { x, y, width, height } = properties;
            return mx >= x && mx <= x + width && my >= y && my <= y + height;
        }

        if (obj_type === 'text') {
            const bbox = this.getBoundingBox(obj, ctx);
            return mx >= bbox.x && mx <= bbox.x + bbox.width && my >= bbox.y && my <= bbox.y + bbox.height;
        }

        return false;
    },

    /**
     * Get the resize handles for an object.
     */
    getHandles(obj, ctx = null) {
        const type = obj.obj_type;
        if (type === 'line' || type === 'arrow') {
            return [
                { id: 'p1', x: obj.properties.x1, y: obj.properties.y1 },
                { id: 'p2', x: obj.properties.x2, y: obj.properties.y2 }
            ];
        }
        
        let bbox = this.getBoundingBox(obj, ctx);
        
        // Return only the 4 corner handles
        return [
            { id: 'nw', x: bbox.x, y: bbox.y },
            { id: 'ne', x: bbox.x + bbox.width, y: bbox.y },
            { id: 'sw', x: bbox.x, y: bbox.y + bbox.height },
            { id: 'se', x: bbox.x + bbox.width, y: bbox.y + bbox.height }
        ];
    },

    /**
     * Determine which resize handle (if any) is under point (mx, my).
     * @returns {'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'p1'|'p2'|null}
     */
    hitTestHandle(obj, mx, my, ctx = null, handleSize = 12) {
        const hs = handleSize / 2;
        const handles = this.getHandles(obj, ctx);

        // Search in reverse order to prefer corners over midpoints if they overlap
        for (let i = handles.length - 1; i >= 0; i--) {
            const h = handles[i];
            if (mx >= h.x - hs && mx <= h.x + hs && my >= h.y - hs && my <= h.y + hs) {
                return h.id;
            }
        }

        // If we didn't hit a corner handle, check if we hit the edges of the bounding box
        if (obj.obj_type !== 'line' && obj.obj_type !== 'arrow') {
            let bbox = this.getBoundingBox(obj, ctx);
            const edgeTolerance = 6;
            
            // Check edges (we prioritize corners above, so we don't need to exclude them strictly here)
            if (Math.abs(my - bbox.y) <= edgeTolerance && mx > bbox.x && mx < bbox.x + bbox.width) return 'n';
            if (Math.abs(my - (bbox.y + bbox.height)) <= edgeTolerance && mx > bbox.x && mx < bbox.x + bbox.width) return 's';
            if (Math.abs(mx - bbox.x) <= edgeTolerance && my > bbox.y && my < bbox.y + bbox.height) return 'w';
            if (Math.abs(mx - (bbox.x + bbox.width)) <= edgeTolerance && my > bbox.y && my < bbox.y + bbox.height) return 'e';
        }

        return null;
    },

    /**
     * Given a resize handle drag, compute new object properties.
     * @returns {Object} New properties to apply via op:modify
     */
    computeResize(obj, handle, startState, dx, dy, ctx = null) {
        const newProps = { ...startState.properties };
        const type = obj.obj_type;

        if (type === 'line' || type === 'arrow') {
            if (handle === 'p1') {
                newProps.x1 += dx;
                newProps.y1 += dy;
            } else if (handle === 'p2') {
                newProps.x2 += dx;
                newProps.y2 += dy;
            }
            return newProps;
        }

        if (type === 'circle' || type === 'heart') {
            let rStart = type === 'circle' ? startState.properties.radius : startState.properties.size;
            let dr = 0;
            if (handle === 'e') dr = dx;
            if (handle === 'w') dr = -dx;
            if (handle === 's') dr = dy;
            if (handle === 'n') dr = -dy;
            if (handle === 'se') dr = Math.max(dx, dy);
            if (handle === 'nw') dr = Math.max(-dx, -dy);
            if (handle === 'sw') dr = Math.max(-dx, dy);
            if (handle === 'ne') dr = Math.max(dx, -dy);
            
            let rNew = rStart + dr;
            if (rNew < 0) {
                // Negative resizing flips it, which for circles just means radius stays positive
                rNew = Math.abs(rNew); 
            }
            
            if (type === 'circle') newProps.radius = Math.max(2, rNew);
            if (type === 'heart') newProps.size = Math.max(5, rNew);
            return newProps;
        }

        if (type === 'rectangle' || type === 'image' || type === 'text') {
            let bbox = this.getBoundingBox(startState, ctx);
            let left = bbox.x;
            let top = bbox.y;
            let right = bbox.x + bbox.width;
            let bottom = bbox.y + bbox.height;

            if (handle.includes('w')) left += dx;
            if (handle.includes('e')) right += dx;
            if (handle.includes('n')) top += dy;
            if (handle.includes('s')) bottom += dy;

            // Allow flipping
            if (left > right) {
                const temp = left; left = right; right = temp;
            }
            if (top > bottom) {
                const temp = top; top = bottom; bottom = temp;
            }

            if (type === 'text') {
                let oldBbox = this.getBoundingBox(startState, ctx);
                let scale = 1;
                
                // Calculate scale based on the primary dragged axis
                if (handle === 'e' || handle === 'se' || handle === 'ne') {
                    scale = (dx + oldBbox.width) / oldBbox.width;
                } else if (handle === 'w' || handle === 'sw' || handle === 'nw') {
                    scale = (oldBbox.width - dx) / oldBbox.width;
                } else if (handle === 's') {
                    scale = (dy + oldBbox.height) / oldBbox.height;
                } else if (handle === 'n') {
                    scale = (oldBbox.height - dy) / oldBbox.height;
                }

                // Prevent negative or zero scale
                scale = Math.max(0.1, scale);

                newProps.font_size = startState.properties.font_size * scale;
                
                // Anchor the text based on the opposite handle
                if (handle.includes('w')) {
                    newProps.x = startState.properties.x + oldBbox.width * (1 - scale);
                } else {
                    newProps.x = startState.properties.x;
                }

                if (handle.includes('n')) {
                    newProps.y = startState.properties.y + oldBbox.height * (1 - scale);
                } else {
                    newProps.y = startState.properties.y;
                }

                return newProps;
            } else {
                newProps.x = left;
                newProps.y = top;
                newProps.width = right - left;
                newProps.height = bottom - top;
            }
            return newProps;
        }

        return newProps;
    },

    /**
     * Compute move properties for an object.
     */
    computeMove(obj, startState, dx, dy) {
        const newProps = { ...startState.properties };
        const type = obj.obj_type;

        if (type === 'line' || type === 'arrow') {
            newProps.x1 += dx;
            newProps.y1 += dy;
            newProps.x2 += dx;
            newProps.y2 += dy;
        } else if (type === 'circle' || type === 'heart') {
            newProps.cx += dx;
            newProps.cy += dy;
        } else if (type === 'pencil') {
            newProps.points = newProps.points.map(pt => [pt[0] + dx, pt[1] + dy]);
        } else {
            newProps.x += dx;
            newProps.y += dy;
        }
        return newProps;
    }
};

window.geometry = geometry;
