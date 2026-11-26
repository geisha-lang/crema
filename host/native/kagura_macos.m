// Kagura Native macOS Cocoa + CoreGraphics Quartz 2D Host (`host/native/kagura_macos.m`)
//
// Executes the exact same 8-byte word-aligned binary `DrawList` produced by `kagura.gfx`
// in a Retina `NSWindow` using CoreGraphics (`CGContextRef`) & CoreText (`NSAttributedString`),
// allowing identical `.gsa` applications to compile to both WebAssembly and native macOS apps.

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Geisha runtime & exported Kagura entry points (note trailing `void *fv` closure param!)
extern void gc_init_with_stack(int64_t heap_words, void *stack_anchor);
extern void gc_enable_generational(void);
extern void *gc_alloc_atomic(int64_t bytes);
extern void __geisha_kagura_boot(void);
extern void kagura_init(double w, double h, void *fv);
extern uint8_t kagura_step_frame(double dt_ms, double w, double h, void *fv);
extern void kagura_pointer_move(double x, double y, void *fv);
extern void kagura_pointer_click(double x, double y, void *fv);
extern void kagura_scroll_wheel(double x, double y, double dy, void *fv);
extern void kagura_key_down(const char *key, void *fv);

static const char *gs_dup_cstr(const char *src) {
    if (!src) src = "";
    size_t len = strlen(src);
    char *dst = (char *)gc_alloc_atomic((int64_t)(len + 1));
    memcpy(dst, src, len + 1);
    return dst;
}

static NSColor *ns_color_from_rgba32(int32_t c) {
    uint32_t u = (uint32_t)c;
    if (u == 0) return nil;
    CGFloat r = ((u >> 24) & 0xFF) / 255.0;
    CGFloat g = ((u >> 16) & 0xFF) / 255.0;
    CGFloat b = ((u >> 8)  & 0xFF) / 255.0;
    CGFloat a = (u & 0xFF) / 255.0;
    return [NSColor colorWithSRGBRed:r green:g blue:b alpha:a];
}

// Latest presented frame command snapshot for Cocoa `drawRect:`
static int64_t *g_words_buf = NULL;
static int32_t  g_word_len  = 0;
static int32_t  g_word_cap  = 0;
static NSMutableArray<NSString *> *g_strs = nil;
static int32_t  g_present_calls = 0;
static NSView  *g_active_view = nil;

void kagura_host_present(const void *words_arr, int32_t word_count, const void *strs_arr, int32_t str_count) {
    g_present_calls++;
    const int64_t *src_words = (const int64_t *)((const char *)words_arr + 8);
    const char * const *src_strs = (const char * const *)((const char *)strs_arr + 8);

    if (word_count > g_word_cap) {
        g_word_cap = word_count * 2 + 256;
        g_words_buf = (int64_t *)realloc(g_words_buf, (size_t)g_word_cap * sizeof(int64_t));
    }
    if (word_count > 0) {
        memcpy(g_words_buf, src_words, (size_t)word_count * sizeof(int64_t));
    }
    g_word_len = word_count;

    if (!g_strs) g_strs = [NSMutableArray arrayWithCapacity:128];
    [g_strs removeAllObjects];
    for (int32_t i = 0; i < str_count; i++) {
        const char *s = src_strs[i];
        [g_strs addObject:(s ? ([NSString stringWithUTF8String:s] ?: @"") : @"")];
    }
    if (g_active_view) {
        [g_active_view setNeedsDisplay:YES];
    }
}

void kagura_host_set_cursor(const char *cursor) {
    if (!g_active_view || !cursor) return;
    if (strcmp(cursor, "pointer") == 0) [[NSCursor pointingHandCursor] set];
    else if (strcmp(cursor, "text") == 0) [[NSCursor IBeamCursor] set];
    else [[NSCursor arrowCursor] set];
}

void kagura_host_focus_ime(const char *inp_id, const char *val, double x, double y, double w, double h) {
    (void)inp_id; (void)val; (void)x; (void)y; (void)w; (void)h;
}

void kagura_host_blur_ime(void) {}

void kagura_host_play_sfx(const char *sfx_id) {
    if (sfx_id && strcmp(sfx_id, "parry") == 0) NSBeep();
}

void kagura_host_save_local(const char *key, const char *val) {
    if (!key || !val) return;
    [[NSUserDefaults standardUserDefaults] setObject:[NSString stringWithUTF8String:val]
                                              forKey:[NSString stringWithUTF8String:key]];
}

void kagura_host_send_net(const char *payload) { (void)payload; }
void kagura_host_connect_net(const char *mode, const char *user, const char *token) {
    (void)mode; (void)user; (void)token;
}

static void cg_add_round_rect(CGContextRef cg, CGRect r, CGFloat rad) {
    CGFloat maxR = fmin(r.size.width, r.size.height) * 0.5;
    CGFloat cr = fmax(0.0, fmin(rad, maxR));
    if (cr <= 0.1) {
        CGContextAddRect(cg, r);
    } else {
        CGPathRef path = CGPathCreateWithRoundedRect(r, cr, cr, NULL);
        CGContextAddPath(cg, path);
        CGPathRelease(path);
    }
}

@interface KaguraCanvasView : NSView
@end

@implementation KaguraCanvasView

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }

- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    for (NSTrackingArea *ta in self.trackingAreas) [self removeTrackingArea:ta];
    NSTrackingArea *area = [[NSTrackingArea alloc]
        initWithRect:self.bounds
             options:(NSTrackingMouseMoved | NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect)
               owner:self
            userInfo:nil];
    [self addTrackingArea:area];
}

- (NSPoint)localPt:(NSEvent *)ev {
    return [self convertPoint:ev.locationInWindow fromView:nil];
}

- (void)mouseMoved:(NSEvent *)ev {
    NSPoint p = [self localPt:ev];
    kagura_pointer_move(p.x, p.y, NULL);
}

- (void)mouseDown:(NSEvent *)ev {
    NSPoint p = [self localPt:ev];
    kagura_pointer_click(p.x, p.y, NULL);
}

- (void)scrollWheel:(NSEvent *)ev {
    NSPoint p = [self localPt:ev];
    double dy = ev.hasPreciseScrollingDeltas ? -ev.scrollingDeltaY : -ev.scrollingDeltaY * 12.0;
    kagura_scroll_wheel(p.x, p.y, dy, NULL);
}

- (void)keyDown:(NSEvent *)ev {
    NSString *chars = ev.charactersIgnoringModifiers;
    if (chars.length > 0) {
        kagura_key_down(gs_dup_cstr(chars.UTF8String), NULL);
    }
}

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    if (!g_words_buf || g_word_len <= 0) return;
    CGContextRef cg = [[NSGraphicsContext currentContext] CGContext];
    if (!cg) return;

    const int32_t *i32 = (const int32_t *)g_words_buf;
    const double  *f64 = (const double  *)g_words_buf;
    CGFloat viewW = self.bounds.size.width;
    CGFloat viewH = self.bounds.size.height;
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);

    int32_t w = 0;
    while (w < g_word_len) {
        int32_t op  = i32[w * 2];
        int32_t aux = i32[w * 2 + 1];
        switch (op) {
            case 1: { // OP_CLEAR_BG
                NSColor *cTop = ns_color_from_rgba32(i32[(w + 1) * 2]) ?: [NSColor colorWithSRGBRed:0.97 green:0.95 blue:0.91 alpha:1.0];
                NSColor *cMid = ns_color_from_rgba32(i32[(w + 1) * 2 + 1]) ?: cTop;
                NSColor *cBot = ns_color_from_rgba32(i32[(w + 2) * 2]) ?: cMid;
                NSArray *cols = @[(__bridge id)cTop.CGColor, (__bridge id)cMid.CGColor, (__bridge id)cBot.CGColor];
                CGFloat locs[3] = {0.0, 0.55, 1.0};
                CGGradientRef grad = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cols, locs);
                CGContextDrawLinearGradient(cg, grad, CGPointMake(0, 0), CGPointMake(0, viewH), 0);
                CGGradientRelease(grad);
                w += 3;
                break;
            }
            case 2: { // OP_RECT
                CGRect r = CGRectMake(f64[w + 1], f64[w + 2], f64[w + 3], f64[w + 4]);
                CGFloat rad = f64[w + 5];
                NSColor *cTop = ns_color_from_rgba32(i32[(w + 6) * 2]);
                NSColor *cBot = ns_color_from_rgba32(i32[(w + 6) * 2 + 1]);
                NSColor *cBd  = ns_color_from_rgba32(i32[(w + 7) * 2]);
                NSColor *cSh  = ns_color_from_rgba32(i32[(w + 7) * 2 + 1]);
                CGFloat lw = f64[w + 8], shY = f64[w + 9], shBlur = f64[w + 10];
                if (r.size.width > 0 && r.size.height > 0) {
                    CGContextSaveGState(cg);
                    if (cSh && shBlur > 0) {
                        CGContextSetShadowWithColor(cg, CGSizeMake(0, -shY), shBlur, cSh.CGColor);
                    }
                    if (cTop || cBot) {
                        NSColor *c1 = cTop ?: cBot;
                        NSColor *c2 = cBot ?: cTop;
                        CGContextSaveGState(cg);
                        cg_add_round_rect(cg, r, rad);
                        if ([c1 isEqual:c2]) {
                            CGContextSetFillColorWithColor(cg, c1.CGColor);
                            CGContextFillPath(cg);
                        } else {
                            CGContextClip(cg);
                            NSArray *cols = @[(__bridge id)c1.CGColor, (__bridge id)c2.CGColor];
                            CGFloat locs[2] = {0.0, 1.0};
                            CGGradientRef grad = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cols, locs);
                            CGContextDrawLinearGradient(cg, grad, CGPointMake(r.origin.x, r.origin.y), CGPointMake(r.origin.x, CGRectGetMaxY(r)), 0);
                            CGGradientRelease(grad);
                        }
                        CGContextRestoreGState(cg);
                    }
                    CGContextSetShadowWithColor(cg, CGSizeZero, 0, NULL);
                    if (cBd && lw > 0) {
                        cg_add_round_rect(cg, r, rad);
                        CGContextSetStrokeColorWithColor(cg, cBd.CGColor);
                        CGContextSetLineWidth(cg, lw);
                        CGContextStrokePath(cg);
                    }
                    if ((aux & 1) != 0 && r.size.width > 10 && r.size.height > 10) {
                        cg_add_round_rect(cg, CGRectInset(r, 3.5, 3.5), fmax(1.0, rad - 1.0));
                        CGContextSetRGBStrokeColor(cg, 0.61, 0.45, 0.17, 0.28);
                        CGContextSetLineWidth(cg, 0.75);
                        CGContextStrokePath(cg);
                    }
                    CGContextRestoreGState(cg);
                }
                w += 11;
                break;
            }
            case 3: { // OP_PROGRESS_BAR
                CGRect r = CGRectMake(f64[w + 1], f64[w + 2], f64[w + 3], f64[w + 4]);
                CGFloat rad = f64[w + 5], ratio = f64[w + 6], trail = f64[w + 7];
                NSColor *cStart = ns_color_from_rgba32(i32[(w + 8) * 2]);
                NSColor *cTrail = ns_color_from_rgba32(i32[(w + 9) * 2]);
                NSColor *cTrack = ns_color_from_rgba32(i32[(w + 9) * 2 + 1]);
                if (cTrack) {
                    cg_add_round_rect(cg, r, rad);
                    CGContextSetFillColorWithColor(cg, cTrack.CGColor);
                    CGContextFillPath(cg);
                }
                if (cTrail && trail > ratio + 0.004) {
                    cg_add_round_rect(cg, CGRectMake(r.origin.x, r.origin.y, r.size.width * trail, r.size.height), rad);
                    CGContextSetFillColorWithColor(cg, cTrail.CGColor);
                    CGContextFillPath(cg);
                }
                if (cStart && ratio > 0.003) {
                    CGFloat fw = fmax(r.size.height, r.size.width * ratio);
                    cg_add_round_rect(cg, CGRectMake(r.origin.x, r.origin.y, fw, r.size.height), rad);
                    CGContextSetFillColorWithColor(cg, cStart.CGColor);
                    CGContextFillPath(cg);
                }
                w += 10;
                break;
            }
            case 4: { // OP_ELLIPSE
                CGRect er = CGRectMake(f64[w + 1] - f64[w + 3], f64[w + 2] - f64[w + 4], f64[w + 3] * 2.0, f64[w + 4] * 2.0);
                NSColor *cFill = ns_color_from_rgba32(i32[(w + 5) * 2]);
                NSColor *cStrk = ns_color_from_rgba32(i32[(w + 5) * 2 + 1]);
                if (cFill) { CGContextSetFillColorWithColor(cg, cFill.CGColor); CGContextFillEllipseInRect(cg, er); }
                if (cStrk && f64[w + 6] > 0) { CGContextSetStrokeColorWithColor(cg, cStrk.CGColor); CGContextSetLineWidth(cg, f64[w + 6]); CGContextStrokeEllipseInRect(cg, er); }
                w += 7;
                break;
            }
            case 5: { // OP_LINE
                NSColor *col = ns_color_from_rgba32(i32[(w + 6) * 2]);
                if (col && f64[w + 5] > 0) {
                    CGContextSaveGState(cg);
                    CGContextSetStrokeColorWithColor(cg, col.CGColor);
                    CGContextSetLineWidth(cg, f64[w + 5]);
                    CGContextSetLineCap(cg, kCGLineCapRound);
                    if ((aux & 1) != 0) { CGFloat dash[2] = {5.0, 5.0}; CGContextSetLineDash(cg, 0, dash, 2); }
                    CGContextMoveToPoint(cg, f64[w + 1], f64[w + 2]);
                    CGContextAddLineToPoint(cg, f64[w + 3], f64[w + 4]);
                    CGContextStrokePath(cg);
                    CGContextRestoreGState(cg);
                }
                w += 7;
                break;
            }
            case 6: { // OP_POLYGON
                int32_t nPts = aux;
                NSColor *cFill = ns_color_from_rgba32(i32[(w + 1) * 2]);
                NSColor *cStrk = ns_color_from_rgba32(i32[(w + 1) * 2 + 1]);
                CGFloat lw = f64[w + 2];
                if (nPts >= 2) {
                    CGContextBeginPath(cg);
                    CGContextMoveToPoint(cg, f64[w + 3], f64[w + 4]);
                    for (int32_t i = 1; i < nPts; i++) CGContextAddLineToPoint(cg, f64[w + 3 + i * 2], f64[w + 4 + i * 2]);
                    CGContextClosePath(cg);
                    if (cFill && cStrk && lw > 0) {
                        CGContextSetFillColorWithColor(cg, cFill.CGColor);
                        CGContextSetStrokeColorWithColor(cg, cStrk.CGColor);
                        CGContextSetLineWidth(cg, lw);
                        CGContextDrawPath(cg, kCGPathFillStroke);
                    } else if (cFill) {
                        CGContextSetFillColorWithColor(cg, cFill.CGColor);
                        CGContextFillPath(cg);
                    } else if (cStrk && lw > 0) {
                        CGContextSetStrokeColorWithColor(cg, cStrk.CGColor);
                        CGContextSetLineWidth(cg, lw);
                        CGContextStrokePath(cg);
                    }
                }
                w += 3 + nPts * 2;
                break;
            }
            case 7: { // OP_RIBBON — single smooth tapered slash polygon
                int32_t nPts = aux;
                NSColor *baseCol = ns_color_from_rgba32(i32[(w + 1) * 2]);
                CGFloat baseAl = f64[w + 2];
                if (nPts >= 2 && baseCol) {
                    CGContextSaveGState(cg);
                    CGMutablePathRef path = CGPathCreateMutable();
                    for (int32_t i = 0; i < nPts; i++) {
                        int32_t prev = w + 3 + (i > 0 ? i - 1 : 0) * 3;
                        int32_t curr = w + 3 + i * 3;
                        int32_t next = w + 3 + (i + 1 < nPts ? i + 1 : nPts - 1) * 3;
                        double tx = f64[next] - f64[prev], ty = f64[next + 1] - f64[prev + 1];
                        double len = hypot(tx, ty); if (len < 1e-6) len = 1.0;
                        double nx = -ty / len, ny = tx / len;
                        double taper = 0.18 + 0.82 * ((double)i / (double)(nPts - 1));
                        double hw = fmax(0.4, f64[curr + 2] * 0.5 * taper);
                        if (i == 0) CGPathMoveToPoint(path, NULL, f64[curr] + nx * hw, f64[curr + 1] + ny * hw);
                        else CGPathAddLineToPoint(path, NULL, f64[curr] + nx * hw, f64[curr + 1] + ny * hw);
                    }
                    for (int32_t i = nPts - 1; i >= 0; i--) {
                        int32_t prev = w + 3 + (i > 0 ? i - 1 : 0) * 3;
                        int32_t curr = w + 3 + i * 3;
                        int32_t next = w + 3 + (i + 1 < nPts ? i + 1 : nPts - 1) * 3;
                        double tx = f64[next] - f64[prev], ty = f64[next + 1] - f64[prev + 1];
                        double len = hypot(tx, ty); if (len < 1e-6) len = 1.0;
                        double nx = -ty / len, ny = tx / len;
                        double taper = 0.18 + 0.82 * ((double)i / (double)(nPts - 1));
                        double hw = fmax(0.4, f64[curr + 2] * 0.5 * taper);
                        CGPathAddLineToPoint(path, NULL, f64[curr] - nx * hw, f64[curr + 1] - ny * hw);
                    }
                    CGPathCloseSubpath(path);
                    CGContextAddPath(cg, path);
                    CGContextClip(cg);
                    CGPathRelease(path);
                    NSColor *c0 = [baseCol colorWithAlphaComponent:(baseCol.alphaComponent * baseAl * 0.08)];
                    NSColor *c1 = [baseCol colorWithAlphaComponent:(baseCol.alphaComponent * baseAl)];
                    NSArray *cols = @[(__bridge id)c0.CGColor, (__bridge id)c1.CGColor];
                    CGFloat locs[2] = {0.0, 1.0};
                    CGGradientRef grad = CGGradientCreateWithColors(cs, (__bridge CFArrayRef)cols, locs);
                    int32_t pStart = w + 3, pEnd = w + 3 + (nPts - 1) * 3;
                    CGContextDrawLinearGradient(cg, grad, CGPointMake(f64[pStart], f64[pStart + 1]), CGPointMake(f64[pEnd], f64[pEnd + 1]), 0);
                    CGGradientRelease(grad);
                    CGContextRestoreGState(cg);
                }
                w += 3 + nPts * 3;
                break;
            }
            case 8: { // OP_TEXT
                if (aux >= 0 && aux < (int32_t)g_strs.count) {
                    NSString *txt = g_strs[(NSUInteger)aux];
                    CGFloat x = f64[w + 1], y = f64[w + 2], sz = f64[w + 3];
                    int32_t styleBits = i32[(w + 4) * 2];
                    NSColor *col = ns_color_from_rgba32(i32[(w + 4) * 2 + 1]) ?: [NSColor blackColor];
                    int32_t famCode = (styleBits >> 16) & 0xFF;
                    int32_t alignCode = (styleBits >> 8) & 0xFF;
                    int32_t wtClass = styleBits & 0xFF;
                    NSFontWeight wt = wtClass >= 7 ? NSFontWeightBold : (wtClass >= 6 ? NSFontWeightSemibold : NSFontWeightRegular);
                    NSFont *font = nil;
                    if (famCode == 1) font = [NSFont fontWithName:@"Songti SC" size:sz] ?: [NSFont systemFontOfSize:sz weight:wt];
                    else if (famCode == 2) font = [NSFont monospacedSystemFontOfSize:sz weight:wt];
                    else font = [NSFont systemFontOfSize:sz weight:wt];
                    NSDictionary *attrs = @{NSFontAttributeName: font, NSForegroundColorAttributeName: col};
                    NSSize tsz = [txt sizeWithAttributes:attrs];
                    CGFloat drawX = alignCode == 1 ? (x - tsz.width * 0.5) : (alignCode == 2 ? (x - tsz.width) : x);
                    [txt drawAtPoint:NSMakePoint(drawX, y - sz * 1.02) withAttributes:attrs];
                }
                w += 5;
                break;
            }
            case 9:   w += 7; break; // OP_IMAGE
            case 10: { // OP_PUSH_CLIP
                CGContextSaveGState(cg);
                CGContextClipToRect(cg, CGRectMake(f64[w + 1], f64[w + 2], f64[w + 3], f64[w + 4]));
                w += 5;
                break;
            }
            case 11: { CGContextRestoreGState(cg); w += 1; break; }
            case 12: { // OP_PUSH_TRANSFORM
                CGContextSaveGState(cg);
                CGContextTranslateCTM(cg, f64[w + 1], f64[w + 2]);
                if (f64[w + 5] != 0.0) CGContextRotateCTM(cg, f64[w + 5] * M_PI / 180.0);
                CGContextScaleCTM(cg, f64[w + 3], f64[w + 4]);
                w += 6;
                break;
            }
            case 13: { CGContextRestoreGState(cg); w += 1; break; }
            case 14: w += 6; break;
            case 15: w += 1; break;
            case 16: { // OP_PUSH_CIRCLE_CLIP
                CGFloat cx = f64[w + 1], cy = f64[w + 2], r = f64[w + 3];
                CGContextSaveGState(cg);
                CGContextBeginPath(cg);
                CGContextAddEllipseInRect(cg, CGRectMake(cx - r, cy - r, r * 2.0, r * 2.0));
                CGContextClip(cg);
                w += 4;
                break;
            }
            default: w = g_word_len; break;
        }
    }
    CGColorSpaceRelease(cs);
    (void)viewW;
}

@end

int main(int argc, const char *argv[]) {
    uint64_t stack_anchor = 0;
    gc_init_with_stack(131072, &stack_anchor);
    gc_enable_generational();
    __geisha_kagura_boot();

    // Headless smoke-check mode for automated CI verification
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--headless-smoke") == 0) {
            @autoreleasepool {
                kagura_init(1280.0, 800.0, NULL);
                kagura_step_frame(16.6, 1280.0, 800.0, NULL);
                kagura_pointer_move(200.0, 180.0, NULL);
                kagura_pointer_click(200.0, 180.0, NULL);
                kagura_step_frame(16.6, 1280.0, 800.0, NULL);
                if (g_present_calls < 2 || g_word_len <= 10) {
                    fprintf(stderr, "Headless smoke check failed: presents=%d words=%d\n", g_present_calls, g_word_len);
                    return 1;
                }
                printf("✓ Kagura native macOS Cocoa/Quartz2D host smoke passed (presents=%d, words=%d, strs=%lu)\n",
                       g_present_calls, g_word_len, (unsigned long)g_strs.count);
                return 0;
            }
        }
    }

    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];

        NSRect initRect = NSMakeRect(0, 0, 1280, 800);
        NSWindow *win = [[NSWindow alloc]
            initWithContentRect:initRect
                      styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                        backing:NSBackingStoreBuffered
                          defer:NO];
        [win setTitle:@"Kagura (神楽) — Pure Geisha Native UI & 2D Stage"];
        [win center];

        KaguraCanvasView *view = [[KaguraCanvasView alloc] initWithFrame:initRect];
        [view setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
        win.contentView = view;
        g_active_view = view;

        kagura_init(1280.0, 800.0, NULL);
        kagura_step_frame(16.6, 1280.0, 800.0, NULL);

        [win makeKeyAndOrderFront:nil];
        [win makeFirstResponder:view];
        [app activate];

        __block CFAbsoluteTime lastTime = CFAbsoluteTimeGetCurrent();
        [NSTimer scheduledTimerWithTimeInterval:(1.0 / 60.0) repeats:YES block:^(NSTimer * _Nonnull timer) {
            (void)timer;
            if (!win.isVisible) { [app terminate:nil]; return; }
            CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
            double dtMs = fmin(100.0, fmax(1.0, (now - lastTime) * 1000.0));
            lastTime = now;
            NSSize sz = view.bounds.size;
            kagura_step_frame(dtMs, sz.width, sz.height, NULL);
        }];

        [app run];
    }
    return 0;
}
