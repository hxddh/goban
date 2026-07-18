const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

// Serve the board UI from frontend/dist (packaged under Resources).
// Inline HTML is capped at 64KiB by the SDK; asset loading has no such limit.
const App = struct {
    env_map: *std.process.Environ.Map,

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
};

const allowed_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

pub fn main(init: std.process.Init) !void {
    var app_state = App{ .env_map = init.environ_map };
    try runner.runWithOptions(app_state.app(), .{
        .app_name = "五子棋",
        .window_title = "五子棋",
        .bundle_id = "dev.hxddh.goban",
        .icon_path = "assets/icon.png",
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
