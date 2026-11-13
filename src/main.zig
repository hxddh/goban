const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

/// v3.2.1:开发服务器的源只在 Debug 构建里放行。此前它也在正式包的白名单里,而白名单
/// 同时决定谁能调下面的文件读写 —— 本机任何占着 5173 端口的页面,只要被导航到,就能用。
const allowed_origins = if (builtin.mode == .Debug)
    [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" }
else
    [_][]const u8{ "zero://app", "zero://inline" };

/// 单个文件的上限。桥的请求 / 回应各 1 MB,base64 再胀 4/3,640 KB 留足余量。
/// 超过时明说「太大」(FileTooLarge),不再像 v3.2.0 那样读满 256 KB 就悄悄截断。
const max_file_bytes: usize = 640 * 1024;

/// v3.2.1:网页只能读写**用户亲手选过**的文件 —— 打开 / 保存对话框返回的、拖进窗口的。
/// 此前 goban.readTextFile / writeTextFile 接受网页给的任何绝对路径。
const max_granted = 16;
const max_path = 4096;

// Empty custom menus → host default bar (View → Full Screen, Window → Zoom).
// Game actions: chrome / sidebar / in-page shortcuts.

const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    /// 第一个事件(lifecycle.start)到来时记下;窗口拖动 / 标题栏几何要用它的平台服务。
    runtime: ?*native_sdk.Runtime = null,
    handlers: [6]native_sdk.BridgeHandler = undefined,
    policies: [6]native_sdk.BridgeCommandPolicy = undefined,
    granted: [max_granted][max_path]u8 = undefined,
    granted_len: [max_granted]usize = [_]usize{0} ** max_granted,
    granted_next: usize = 0,

    fn grant(self: *@This(), path: []const u8) void {
        if (path.len == 0 or path.len > max_path) return;
        if (self.isGranted(path)) return;
        const slot = self.granted_next % max_granted;
        @memcpy(self.granted[slot][0..path.len], path);
        self.granted_len[slot] = path.len;
        self.granted_next += 1;
    }

    fn isGranted(self: *const @This(), path: []const u8) bool {
        for (0..max_granted) |i| {
            const n = self.granted_len[i];
            if (n == path.len and n > 0 and std.mem.eql(u8, self.granted[i][0..n], path)) return true;
        }
        return false;
    }

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
        self.handlers[4] = .{
            .name = "goban.openDialog",
            .context = self,
            .invoke_fn = openDialog,
        };
        self.handlers[5] = .{
            .name = "goban.saveDialog",
            .context = self,
            .invoke_fn = saveDialog,
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
        // 拖进窗口的文件是用户亲手给的:登记下来,网页随后的 readTextFile 才放行
        .files_dropped => |drop| {
            for (drop.paths) |path| self.grant(path);
        },
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
    var path_buf: [max_path]u8 = undefined;
    const path = jsonUnescape(path_raw, &path_buf) orelse return error.InvalidRequest;
    if (path.len == 0) return error.InvalidRequest;
    if (!self.isGranted(path)) return error.PathNotGranted;
    if (b64.len == 0) return error.InvalidRequest;

    const dec = std.base64.standard.Decoder;
    const dec_len = dec.calcSizeForSlice(b64) catch return error.InvalidRequest;
    if (dec_len > max_file_bytes) return error.FileTooLarge;
    const decoded = std.heap.page_allocator.alloc(u8, dec_len) catch return error.HandlerFailed;
    defer std.heap.page_allocator.free(decoded);
    dec.decode(decoded, b64) catch return error.InvalidRequest;

    var file = std.Io.Dir.createFileAbsolute(self.io, path, .{ .truncate = true }) catch return error.HandlerFailed;
    defer file.close(self.io);
    file.writeStreamingAll(self.io, decoded) catch return error.HandlerFailed;

    return std.fmt.bufPrint(output, "true", .{}) catch "true";
}

fn readTextFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const path_raw = jsonStringField(invocation.request.payload, "path") orelse return error.InvalidRequest;
    var path_buf: [max_path]u8 = undefined;
    const path = jsonUnescape(path_raw, &path_buf) orelse return error.InvalidRequest;
    if (path.len == 0) return error.InvalidRequest;
    if (!self.isGranted(path)) return error.PathNotGranted;

    var file = std.Io.Dir.openFileAbsolute(self.io, path, .{}) catch return error.HandlerFailed;
    defer file.close(self.io);

    // 多读一个字节:读满了就是超长,明说,不截断
    const raw = std.heap.page_allocator.alloc(u8, max_file_bytes + 1) catch return error.HandlerFailed;
    defer std.heap.page_allocator.free(raw);
    const n = file.readPositionalAll(self.io, raw, 0) catch return error.HandlerFailed;
    if (n == 0) return error.InvalidRequest;
    if (n > max_file_bytes) return error.FileTooLarge;

    const enc = std.base64.standard.Encoder;
    const encoded = std.heap.page_allocator.alloc(u8, enc.calcSize(n)) catch return error.HandlerFailed;
    defer std.heap.page_allocator.free(encoded);
    _ = enc.encode(encoded, raw[0..n]);

    // JSON string result(写不下时 writeJsonStringValue 回空切片 —— 当作失败,不回半截)
    const out = native_sdk.bridge.writeJsonStringValue(output, encoded);
    if (out.len == 0) return error.FileTooLarge;
    return out;
}

/// 打开对话框(单选)。选中的路径登记为可读;取消回 null。
fn openDialog(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const runtime = self.runtime orelse return error.HandlerFailed;
    var title_buf: [512]u8 = undefined;
    const title = if (jsonStringField(invocation.request.payload, "title")) |raw| (jsonUnescape(raw, &title_buf) orelse "") else "";
    var paths_buf: [max_path * 2]u8 = undefined;
    const result = try runtime.showOpenDialog(.{ .title = title, .allow_multiple = false }, &paths_buf);
    if (result.count == 0 or result.paths.len == 0) return std.fmt.bufPrint(output, "null", .{});
    const first = if (std.mem.indexOfScalar(u8, result.paths, '\n')) |nl| result.paths[0..nl] else result.paths;
    self.grant(first);
    return native_sdk.bridge.writeJsonStringValue(output, first);
}

/// 保存对话框。选中的路径登记为可写;取消回 null。
fn saveDialog(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const runtime = self.runtime orelse return error.HandlerFailed;
    var title_buf: [512]u8 = undefined;
    var name_buf: [512]u8 = undefined;
    const payload = invocation.request.payload;
    const title = if (jsonStringField(payload, "title")) |raw| (jsonUnescape(raw, &title_buf) orelse "") else "";
    const name = if (jsonStringField(payload, "defaultName")) |raw| (jsonUnescape(raw, &name_buf) orelse "") else "";
    var path_buf: [max_path]u8 = undefined;
    const chosen = try runtime.showSaveDialog(.{ .title = title, .default_name = name }, &path_buf);
    const path = chosen orelse return std.fmt.bufPrint(output, "null", .{});
    if (path.len == 0) return std.fmt.bufPrint(output, "null", .{});
    self.grant(path);
    return native_sdk.bridge.writeJsonStringValue(output, path);
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

test "granted paths: only what was granted, ring keeps the latest" {
    var app = App{ .env_map = undefined, .io = undefined };
    try std.testing.expect(!app.isGranted("/tmp/a.sgf"));
    app.grant("/tmp/a.sgf");
    try std.testing.expect(app.isGranted("/tmp/a.sgf"));
    try std.testing.expect(!app.isGranted("/tmp/a.sg"));
    try std.testing.expect(!app.isGranted("/tmp/a.sgf2"));
    try std.testing.expect(!app.isGranted(""));
    var buf: [32]u8 = undefined;
    for (0..max_granted) |i| app.grant(try std.fmt.bufPrint(&buf, "/tmp/f{d}", .{i}));
    try std.testing.expect(!app.isGranted("/tmp/a.sgf")); // 被挤出
    try std.testing.expect(app.isGranted("/tmp/f15"));
}

test "release builds do not trust the dev server origin" {
    var has_dev = false;
    for (allowed_origins) |o| {
        if (std.mem.eql(u8, o, "http://127.0.0.1:5173")) has_dev = true;
    }
    try std.testing.expectEqual(builtin.mode == .Debug, has_dev);
}
