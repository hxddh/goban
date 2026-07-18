const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const allowed_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

// Serve the board UI from frontend/dist (packaged under Resources).
// Inline HTML is capped at 64KiB by the SDK; asset loading has no such limit.
const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    handlers: [1]native_sdk.BridgeHandler = undefined,
    policies: [1]native_sdk.BridgeCommandPolicy = undefined,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "goban",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
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
        self.policies[0] = .{
            .name = "goban.writeTextFile",
            .origins = &allowed_origins,
        };
        return .{
            .policy = .{
                .enabled = true,
                .commands = self.policies[0..],
            },
            .registry = .{ .handlers = self.handlers[0..] },
        };
    }
};

/// Extract a JSON string field value (no unescape; paths/base64 need none).
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

fn writeTextFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
    const self: *App = @ptrCast(@alignCast(context));
    const path = jsonStringField(invocation.request.payload, "path") orelse return error.InvalidRequest;
    const b64 = jsonStringField(invocation.request.payload, "b64") orelse return error.InvalidRequest;
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

pub fn main(init: std.process.Init) !void {
    var app_state = App{ .env_map = init.environ_map, .io = init.io };
    try runner.runWithOptions(app_state.app(), .{
        .app_name = "五子棋",
        .window_title = "五子棋",
        .bundle_id = "dev.hxddh.goban",
        .icon_path = "assets/icon.png",
        .js_window_api = true,
        .bridge = app_state.bridge(),
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
