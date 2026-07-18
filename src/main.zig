const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

// Full board UI: wood goban, grid lines, stones, Chinese chrome.
const html = @embedFile("board.html");

const App = struct {
    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "goban",
            .source = native_sdk.WebViewSource.html(html),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        _ = context;
        return native_sdk.WebViewSource.html(html);
    }
};

const allowed_origins = [_][]const u8{ "zero://app", "zero://inline" };

pub fn main(init: std.process.Init) !void {
    var app_state = App{};
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

test "embedded board html is non-empty" {
    try std.testing.expect(html.len > 1000);
}
