const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const allowed_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

// Empty custom menus → host default bar (View → Full Screen, Window → Zoom).
// Game actions: chrome / sidebar / in-page shortcuts.

const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    /// 第一个事件(lifecycle.start)到来时记下;窗口拖动 / 标题栏几何要用它的平台服务。
    runtime: ?*native_sdk.Runtime = null,
    handlers: [4]native_sdk.BridgeHandler = undefined,
    policies: [4]native_sdk.BridgeCommandPolicy = undefined,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "goban",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
            .event_fn = onEvent,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }

    fn bridge(self: *@This()) native_sdk.BridgeDispatcher {
        self.handlers[0] = .{
            .name = "goban.writeTextFile",
            .context = self,
            .invoke_fn = writeTextFile,
        };
        self.handlers[1] = .{
            .name = "goban.readTextFile",
            .context = self,
            .invoke_fn = readTextFile,
        };
        self.handlers[2] = .{
            .name = "goban.windowDrag",
            .context = self,
            .invoke_fn = windowDrag,
        };
        self.handlers[3] = .{
            .name = "goban.windowChrome",
            .context = self,
            .invoke_fn = windowChrome,
        };
        for (self.handlers, 0..) |handler, i| {
            self.policies[i] = .{ .name = handler.name, .origins = &allowed_origins };
        }
        return .{
            .policy = .{
                .enabled = true,
                .commands = self.policies[0..],
            },
            .registry = .{ .handlers = self.handlers[0..] },
        };
    }
};

fn onEvent(context: *anyopaque, runtime: *native_sdk.Runtime, event: native_sdk.Event) anyerror!void {
    const self: *App = @ptrCast(@alignCast(context));
    self.runtime = runtime;
    switch (event) {
        .command => |cmd| {
            var buf: [256]u8 = undefined;
            const detail = std.fmt.bufPrint(
                &buf,
                "{{\"id\":\"{s}\",\"command\":\"{s}\",\"key\":\"\",\"windowId\":{d},\"modifiers\":{{\"primary\":false,\"command\":false,\"control\":false,\"option\":false,\"shift\":false}}}}",
                .{ cmd.name, cmd.name, if (cmd.window_id == 0) @as(u64, 1) else cmd.window_id },
            ) catch return;
            const wid: native_sdk.WindowId = if (cmd.window_id == 0) 1 else cmd.window_id;
            runtime.emitWindowEvent(wid, "shortcut", detail) catch {};
        },
        else => {},
    }
}

fn jsonStringField(payload: []const u8, key: []const u8) ?[]const u8 {
    var key_buf: [96]u8 = undefined;
    if (key.len + 2 > key_buf.len) return null;
    const needle = std.fmt.bufPrint(&key_buf, "\"{s}\"", .{key}) catch return null;
    const at = std.mem.indexOf(u8, payload, needle) orelse return null;
    var i = at + needle.len;
    while (i < payload.len and (payload[i] == ' ' or payload[i] == '\t' or payload[i] == '\n' or payload[i] == '\r' or payload[i] == ':')) : (i += 1) {}
    if (i >= payload.len or payload[i] != '"') return null;
    i += 1;
    const start = i;
    while (i < payload.len) : (i += 1) {
        if (payload[i] == '\\') {
            i += 1;
            continue;
        }
        if (payload[i] == '"') return payload[start..i];
    }
    return null;
}

/// Decode a JSON string slice (contents between quotes) into `out`.
/// Handles \\ \" \/ \n \r \t — enough for file paths from the bridge.
fn jsonUnescape(raw: []const u8, out: []u8) ?[]const u8 {
    var wi: usize = 0;
    var i: usize = 0;
    while (i < raw.len) : (i += 1) {
        if (wi >= out.len) return null;
        if (raw[i] != '\\') {
            out[wi] = raw[i];
            wi += 1;
            continue;
        }
        i += 1;
        if (i >= raw.len) return null;
        const c: u8 = switch (raw[i]) {
            '"', '\\', '/' => raw[i],
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            else => return null,
        };
        out[wi] = c;
        wi += 1;
    }
    return out[0..wi];
}

fn writeTextFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const path_raw = jsonStringField(invocation.request.payload, "path") orelse return error.InvalidRequest;
    const b64 = jsonStringField(invocation.request.payload, "b64") orelse return error.InvalidRequest;
    // Paths need JSON unescape (Windows `C:\…` arrives as `C:\\…`); base64 is
    // ASCII without escapes under JSON.stringify, so the raw slice is fine.
    var path_buf: [4096]u8 = undefined;
    const path = jsonUnescape(path_raw, &path_buf) orelse return error.InvalidRequest;
    if (path.len == 0 or path.len > 4096) return error.InvalidRequest;
    if (b64.len == 0 or b64.len > 512 * 1024) return error.InvalidRequest;

    var decoded_buf: [384 * 1024]u8 = undefined;
    const dec = std.base64.standard.Decoder;
    const dec_len = dec.calcSizeForSlice(b64) catch return error.InvalidRequest;
    if (dec_len > decoded_buf.len) return error.InvalidRequest;
    dec.decode(decoded_buf[0..dec_len], b64) catch return error.InvalidRequest;

    var file = std.Io.Dir.createFileAbsolute(self.io, path, .{ .truncate = true }) catch return error.HandlerFailed;
    defer file.close(self.io);
    file.writeStreamingAll(self.io, decoded_buf[0..dec_len]) catch return error.HandlerFailed;

    return std.fmt.bufPrint(output, "true", .{}) catch "true";
}

fn readTextFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const path_raw = jsonStringField(invocation.request.payload, "path") orelse return error.InvalidRequest;
    var path_buf: [4096]u8 = undefined;
    const path = jsonUnescape(path_raw, &path_buf) orelse return error.InvalidRequest;
    if (path.len == 0 or path.len > 4096) return error.InvalidRequest;

    var file = std.Io.Dir.openFileAbsolute(self.io, path, .{}) catch return error.HandlerFailed;
    defer file.close(self.io);

    var raw_buf: [256 * 1024]u8 = undefined;
    const n = file.readPositionalAll(self.io, &raw_buf, 0) catch return error.HandlerFailed;
    if (n == 0) return error.InvalidRequest;

    var b64_buf: [360 * 1024]u8 = undefined;
    const enc = std.base64.standard.Encoder;
    const enc_len = enc.calcSize(n);
    if (enc_len > b64_buf.len) return error.InvalidRequest;
    const encoded = enc.encode(b64_buf[0..enc_len], raw_buf[0..n]);

    // JSON string result
    return native_sdk.bridge.writeJsonStringValue(output, encoded);
}

/// 隐藏标题栏(macOS hidden_inset_tall)下,前端顶栏的空白处就是标题栏:mousedown 时
/// 网页调这里,平台拿当前这次按下交给 performWindowDragWithEvent —— 真移动了才拖,
/// 双击照系统偏好缩放。标准标题栏的窗口与 Windows 上调了也只是什么都不做。
fn windowDrag(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const runtime = self.runtime orelse return error.HandlerFailed;
    runtime.options.platform.services.startWindowDrag(invocation.source.window_id) catch {};
    return std.fmt.bufPrint(output, "true", .{}) catch "true";
}

/// 红绿灯与标题栏带在内容上压了多少:顶栏据此加高、左边让位。标准标题栏、全屏、
/// Windows 一律回 0,网页就按原样排。
fn windowChrome(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const runtime = self.runtime orelse return std.fmt.bufPrint(output, "{{\"top\":0,\"left\":0,\"right\":0}}", .{});
    const chrome = runtime.options.platform.services.windowChrome(invocation.source.window_id);
    return std.fmt.bufPrint(output, "{{\"top\":{d},\"left\":{d},\"right\":{d},\"buttonsY\":{d},\"buttonsH\":{d}}}", .{
        chrome.insets.top,
        chrome.insets.left,
        chrome.insets.right,
        chrome.buttons.y,
        chrome.buttons.height,
    });
}

pub fn main(init: std.process.Init) !void {
    var app_state = App{ .env_map = init.environ_map, .io = init.io };
    try runner.runWithOptions(app_state.app(), .{
        .app_name = "五子棋",
        .window_title = "五子棋",
        .bundle_id = "dev.hxddh.goban",
        .icon_path = "assets/icon.png",
        .js_window_api = true,
        .bridge = app_state.bridge(),
        .menus = &.{},
        .security = .{
            .navigation = .{ .allowed_origins = &allowed_origins },
        },
    }, init);
}

test "production source uses frontend assets" {
    const source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" });
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.assets, source.kind);
    try std.testing.expectEqualStrings("frontend/dist", source.asset_options.?.root_path);
}

test "jsonUnescape windows path" {
    var buf: [64]u8 = undefined;
    // JSON payload slice for "C:\\Users\\x" (two backslash chars per separator)
    const raw = "C:\\\\Users\\\\x";
    const got = jsonUnescape(raw, &buf) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("C:\\Users\\x", got);
}

test "jsonUnescape plain path unchanged" {
    var buf: [64]u8 = undefined;
    const got = jsonUnescape("/tmp/goban.sgf", &buf) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("/tmp/goban.sgf", got);
}
