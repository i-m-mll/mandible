use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

pub const HEADER_HEIGHT: f64 = 42.0;

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    width: f64,
    height: f64,
    device_pixel_ratio: f64,
    visual_scale: f64,
    offset_left: f64,
    offset_top: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Glyph {
    name: String,
    rect: Rect,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomFrame {
    reason: String,
    header: Rect,
    back_icon: Option<Rect>,
    glyphs: Vec<Glyph>,
    viewport: Viewport,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedFrame {
    pub bounds: Rect,
    pub reservation: f64,
    header: Rect,
}

#[derive(Default)]
pub struct FrameState {
    pub applied: Option<AppliedFrame>,
    dom: Option<DomFrame>,
}

pub struct Observation {
    pub bounds: Rect,
    pub snapshot: serde_json::Value,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc::sync_channel;
    use std::time::Duration;

    fn on_webview<T: Send + 'static>(
        window: &tauri::WebviewWindow,
        task: impl FnOnce(&NSWindow, &WKWebView) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (sender, receiver) = sync_channel(1);
        window
            .with_webview(move |platform| {
                let native = unsafe { &*(platform.ns_window() as *const NSWindow) };
                let webview = unsafe { &*(platform.inner() as *const WKWebView) };
                // The caller may have timed out or its window may have closed.
                let _ = sender.send(task(native, webview));
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?
    }

    fn frame(native: &NSWindow, view: &NSView) -> Result<Rect, String> {
        let owner = view
            .window()
            .ok_or("Native view is not attached to a window")?;
        let screen = owner.convertRectToScreen(view.convertRect_toView(view.bounds(), None));
        let window = native.frame();
        Ok(Rect {
            left: screen.origin.x - window.origin.x,
            top: window.origin.y + window.size.height - screen.origin.y - screen.size.height,
            width: screen.size.width,
            height: screen.size.height,
        })
    }

    fn buttons(native: &NSWindow) -> Result<Vec<Rect>, String> {
        [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .into_iter()
        .map(|kind| {
            let button = native
                .standardWindowButton(kind)
                .ok_or("Missing native window button")?;
            frame(native, &button)
        })
        .collect()
    }

    fn union(rects: &[Rect]) -> Rect {
        let left = rects
            .iter()
            .map(|rect| rect.left)
            .fold(f64::INFINITY, f64::min);
        let top = rects
            .iter()
            .map(|rect| rect.top)
            .fold(f64::INFINITY, f64::min);
        let right = rects
            .iter()
            .map(|rect| rect.left + rect.width)
            .fold(f64::NEG_INFINITY, f64::max);
        let bottom = rects
            .iter()
            .map(|rect| rect.top + rect.height)
            .fold(f64::NEG_INFINITY, f64::max);
        Rect {
            left,
            top,
            width: right - left,
            height: bottom - top,
        }
    }

    fn scale(webview: &WKWebView, dom: Option<&DomFrame>) -> f64 {
        (unsafe { webview.pageZoom() }) * dom.map_or(1.0, |dom| dom.viewport.visual_scale)
    }

    fn map_css(rect: Rect, webview: Rect, dom: &DomFrame, scale: f64) -> Rect {
        Rect {
            left: webview.left + (rect.left - dom.viewport.offset_left) * scale,
            top: webview.top + (rect.top - dom.viewport.offset_top) * scale,
            width: rect.width * scale,
            height: rect.height * scale,
        }
    }

    fn position(
        window: &tauri::WebviewWindow,
        state: Arc<Mutex<FrameState>>,
    ) -> Result<(), String> {
        let dom = state
            .lock()
            .expect("native frame lock poisoned")
            .dom
            .clone();
        let applied = on_webview(window, move |native, webview| {
            if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
                return Ok(None);
            }
            webview.layoutSubtreeIfNeeded();
            let web = frame(native, webview)?;
            let scale = scale(webview, dom.as_ref());
            let header = dom.as_ref().map_or(
                Rect {
                    left: web.left,
                    top: web.top,
                    width: web.width,
                    height: HEADER_HEIGHT * scale,
                },
                |dom| map_css(dom.header, web, dom, scale),
            );
            let existing = buttons(native)?;
            let group = union(&existing);
            let padding = (header.height - group.height) / 2.0;
            assert!(
                padding >= 0.0,
                "native controls exceed the frame header height"
            );
            let window_frame = native.frame();
            for (kind, rect) in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .into_iter()
            .zip(existing)
            {
                let button = native
                    .standardWindowButton(kind)
                    .ok_or("Missing native window button")?;
                let parent = unsafe { button.superview() }.ok_or("Missing native button parent")?;
                let owner = parent
                    .window()
                    .ok_or("Native button parent has no window")?;
                let left = header.left + padding + rect.left - group.left;
                let top = header.top + (header.height - rect.height) / 2.0;
                let mut screen = button.bounds();
                screen.origin.x = window_frame.origin.x + left;
                screen.origin.y =
                    window_frame.origin.y + window_frame.size.height - top - rect.height;
                screen.size.width = rect.width;
                screen.size.height = rect.height;
                let local = parent.convertRect_fromView(owner.convertRectFromScreen(screen), None);
                button.setFrameOrigin(local.origin);
            }
            let bounds = union(&buttons(native)?);
            let left_padding = bounds.left - header.left;
            Ok(Some(AppliedFrame {
                bounds,
                header,
                reservation: (bounds.left + bounds.width + left_padding * 1.5 - header.left)
                    / scale,
            }))
        })?;
        if let Some(applied) = applied {
            let mut state = state.lock().expect("native frame lock poisoned");
            if state
                .applied
                .map(|previous| (previous.bounds, previous.reservation))
                != Some((applied.bounds, applied.reservation))
            {
                eprintln!(
                    "native-frame-applied {}",
                    serde_json::to_string(&applied).expect("native geometry is finite")
                );
            }
            state.applied = Some(applied);
        }
        Ok(())
    }

    pub fn install(
        window: &tauri::WebviewWindow,
        state: Arc<Mutex<FrameState>>,
    ) -> Result<(), String> {
        position(window, state.clone())?;
        let target = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                let task_window = target.clone();
                let state = state.clone();
                target
                    .run_on_main_thread(move || {
                        position(&task_window, state).expect("native frame layout failed")
                    })
                    .expect("native frame layout dispatch failed");
            }
        });
        Ok(())
    }

    pub async fn observe(
        window: tauri::WebviewWindow,
        state: Arc<Mutex<FrameState>>,
        dom: Option<DomFrame>,
    ) -> Result<Observation, String> {
        let applied = state.lock().expect("native frame lock poisoned").applied;
        let input = dom.clone();
        let result = tauri::async_runtime::spawn_blocking(move || on_webview(&window, move |native, webview| {
            let web = frame(native, webview)?;
            let content = native.contentView().ok_or("Missing native content view")?;
            let content = frame(native, &content)?;
            let button_rects = buttons(native)?;
            let bounds = union(&button_rects);
            let scale = scale(webview, input.as_ref());
            let header = input.as_ref().map(|dom| map_css(dom.header, web, dom, scale));
            let back = input.as_ref().and_then(|dom| dom.back_icon.map(|rect| map_css(rect, web, dom, scale)));
            let glyphs = input.as_ref().map(|dom| {
                dom.glyphs.iter().map(|glyph| {
                    let rect = map_css(glyph.rect, web, dom, scale);
                    let center_error = header.map(|header| rect.top + rect.height / 2.0 - header.top - header.height / 2.0);
                    serde_json::json!({ "name": glyph.name, "rect": rect, "centerError": center_error })
                }).collect::<Vec<_>>()
            });
            let window = native.frame();
            let snapshot = serde_json::json!({
                "coordinateSpace": "window-logical-points-top-left", "reason": input.as_ref().map(|dom| &dom.reason),
                "window": {"left": 0.0, "top": 0.0, "width": window.size.width, "height": window.size.height},
                "webview": web, "contentView": content, "buttons": button_rects, "group": bounds,
                "header": header, "backIcon": back, "glyphs": glyphs,
                "pageZoom": unsafe { webview.pageZoom() }, "backingScale": native.backingScaleFactor(),
                "cssToLogicalScale": scale, "dom": input, "lastApplied": applied,
                "fullscreen": native.styleMask().contains(NSWindowStyleMask::FullScreen),
                "topClearance": header.map(|header| bounds.top - header.top),
                "bottomClearance": header.map(|header| header.top + header.height - bounds.top - bounds.height),
                "leftClearance": header.map(|header| bounds.left - header.left),
                "buttonCenterErrors": header.map(|header| button_rects.iter().map(|button| button.top + button.height / 2.0 - header.top - header.height / 2.0).collect::<Vec<_>>()),
                "backIconGap": back.map(|back| back.left - bounds.left - bounds.width),
            });
            eprintln!("native-frame-observed {}", snapshot);
            Ok(Observation { bounds, snapshot })
        })).await.map_err(|error| error.to_string())??;
        if let Some(dom) = dom {
            state.lock().expect("native frame lock poisoned").dom = Some(dom);
        }
        Ok(result)
    }
}

#[cfg(target_os = "macos")]
pub use macos::{install, observe};
