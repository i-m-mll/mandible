use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

pub const HEADER_HEIGHT: f64 = 42.0;

pub fn presentation() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos-overlay"
    } else {
        "system"
    }
}

pub fn host_initialization_script() -> String {
    let host = serde_json::json!({
        "kind": "tauri", "platform": std::env::consts::OS,
        "framePresentation": presentation(),
    });
    format!("Object.defineProperty(window, '__MANDIBLE_NATIVE_HOST__', {{ value: Object.freeze({host}) }});")
}

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
    fullscreen: Option<bool>,
}

pub struct Observation {
    pub fullscreen: bool,
    pub bounds: Rect,
    pub snapshot: serde_json::Value,
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use block2::RcBlock;
    use objc2::{rc::Retained, MainThreadMarker, Message};
    use objc2_app_kit::{
        NSView, NSWindow, NSWindowButton, NSWindowDidEnterFullScreenNotification,
        NSWindowDidExitFullScreenNotification, NSWindowDidUpdateNotification, NSWindowStyleMask,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};
    use objc2_web_kit::WKWebView;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::ptr::NonNull;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::time::{Duration, Instant};
    use tauri::{Emitter, Manager};

    thread_local! {
        static INSTALLED_FRAME: RefCell<Option<InstalledFrame>> = RefCell::new(None);
    }

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

    #[derive(Default, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Diagnostics {
        entries: BTreeMap<&'static str, u64>,
        nested_entries: u64,
        corrections: u64,
        mutations: u64,
        state_notifications_queued: u64,
        max_incoming_center_error: f64,
        max_incoming_left_error: f64,
        max_completed_center_error: f64,
        max_completed_left_error: f64,
        first_correction: Option<serde_json::Value>,
        first_exception: Option<serde_json::Value>,
    }

    struct NativeFrame {
        native: Retained<NSWindow>,
        webview: Retained<WKWebView>,
        window: tauri::WebviewWindow,
        state: Arc<Mutex<FrameState>>,
        active: Arc<AtomicBool>,
        updating: Cell<bool>,
        diagnostics: RefCell<Diagnostics>,
        started: Instant,
    }

    struct InstalledFrame {
        controller: Rc<NativeFrame>,
        cleanup: Box<dyn FnOnce()>,
    }

    struct UpdateGuard<'a>(&'a Cell<bool>);
    impl Drop for UpdateGuard<'_> {
        fn drop(&mut self) {
            self.0.set(false);
        }
    }

    impl NativeFrame {
        fn reconcile(&self, event: &'static str) -> Result<(), String> {
            MainThreadMarker::new().expect("native frame update must run on the main thread");
            *self
                .diagnostics
                .borrow_mut()
                .entries
                .entry(event)
                .or_default() += 1;
            if !self.active.load(Ordering::Acquire) {
                return Ok(());
            }
            if self.updating.replace(true) {
                self.diagnostics.borrow_mut().nested_entries += 1;
                return Ok(());
            }
            let _guard = UpdateGuard(&self.updating);
            let result = self.layout(event);
            match result {
                Ok((fullscreen, applied)) => self.publish(fullscreen, applied),
                Err(error) => {
                    let mut diagnostics = self.diagnostics.borrow_mut();
                    if diagnostics.first_exception.is_none() {
                        let sample = serde_json::json!({
                            "phase": event, "monotonicMicros": self.started.elapsed().as_micros(), "error": error,
                        });
                        eprintln!("native-frame-exception {}", sample);
                        diagnostics.first_exception = Some(sample);
                    }
                    Err(error)
                }
            }
        }

        fn layout(&self, event: &'static str) -> Result<(bool, Option<AppliedFrame>), String> {
            self.native.layoutIfNeeded();
            if self
                .native
                .styleMask()
                .contains(NSWindowStyleMask::FullScreen)
            {
                return Ok((true, None));
            }
            let dom = self
                .state
                .lock()
                .expect("native frame lock poisoned")
                .dom
                .clone();
            let native = &self.native;
            let web = frame(native, &self.webview)?;
            let scale = scale(&self.webview, dom.as_ref());
            let header = Rect {
                left: web.left,
                top: web.top,
                width: web.width,
                height: HEADER_HEIGHT * scale,
            };
            let existing = buttons(native)?;
            let group = union(&existing);
            let padding = (header.height - group.height) / 2.0;
            assert!(
                padding >= 0.0,
                "native controls exceed the frame header height"
            );
            let window_frame = native.frame();
            let tolerance = 0.5 / native.backingScaleFactor();
            let desired: Vec<_> = existing
                .iter()
                .map(|rect| {
                    (
                        header.left + padding + rect.left - group.left,
                        header.top + (header.height - rect.height) / 2.0,
                    )
                })
                .collect();
            let incoming_center_error = existing
                .iter()
                .map(|rect| (rect.top + rect.height / 2.0 - header.top - header.height / 2.0).abs())
                .fold(0.0, f64::max);
            let incoming_left_error = (group.left - header.left - padding).abs();
            let mut mutations = 0;
            for ((kind, rect), &(left, top)) in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .into_iter()
            .zip(existing.iter())
            .zip(desired.iter())
            {
                if (rect.left - left).abs() <= tolerance && (rect.top - top).abs() <= tolerance {
                    continue;
                }
                let button = native
                    .standardWindowButton(kind)
                    .ok_or("Missing native window button")?;
                let parent = unsafe { button.superview() }.ok_or("Missing native button parent")?;
                let owner = parent
                    .window()
                    .ok_or("Native button parent has no window")?;
                let mut screen = button.bounds();
                screen.origin.x = window_frame.origin.x + left;
                screen.origin.y =
                    window_frame.origin.y + window_frame.size.height - top - rect.height;
                screen.size.width = rect.width;
                screen.size.height = rect.height;
                let local = parent.convertRect_fromView(owner.convertRectFromScreen(screen), None);
                button.setFrameOrigin(local.origin);
                mutations += 1;
            }
            let actual = buttons(native)?;
            let bounds = union(&actual);
            let center_error = actual
                .iter()
                .map(|rect| (rect.top + rect.height / 2.0 - header.top - header.height / 2.0).abs())
                .fold(0.0, f64::max);
            let left_error = actual
                .iter()
                .zip(desired.iter())
                .map(|(rect, &(left, _))| (rect.left - left).abs())
                .fold(0.0, f64::max);
            {
                let mut diagnostics = self.diagnostics.borrow_mut();
                diagnostics.max_incoming_center_error = diagnostics
                    .max_incoming_center_error
                    .max(incoming_center_error);
                diagnostics.max_incoming_left_error =
                    diagnostics.max_incoming_left_error.max(incoming_left_error);
                diagnostics.max_completed_center_error =
                    diagnostics.max_completed_center_error.max(center_error);
                diagnostics.max_completed_left_error =
                    diagnostics.max_completed_left_error.max(left_error);
                diagnostics.mutations += mutations;
                if mutations > 0 {
                    diagnostics.corrections += 1;
                    if diagnostics.first_correction.is_none() {
                        diagnostics.first_correction = Some(serde_json::json!({
                            "phase": event, "stage": "completed-layout", "monotonicMicros": self.started.elapsed().as_micros(),
                            "before": existing, "after": actual, "header": header,
                        }));
                    }
                }
            }
            if center_error > tolerance || left_error > tolerance {
                let mut diagnostics = self.diagnostics.borrow_mut();
                if diagnostics.first_exception.is_none() {
                    let sample = serde_json::json!({
                        "phase": event, "stage": "completed-pass", "monotonicMicros": self.started.elapsed().as_micros(),
                        "before": existing, "after": actual, "desiredOrigins": desired, "header": header,
                        "centerError": center_error, "leftError": left_error, "tolerance": tolerance,
                    });
                    eprintln!("native-frame-exception {}", sample);
                    diagnostics.first_exception = Some(sample);
                }
                return Err(format!("native frame verification failed before display: center error {center_error}, left error {left_error}, tolerance {tolerance}"));
            }
            let left_padding = bounds.left - header.left;
            Ok((
                false,
                Some(AppliedFrame {
                    bounds,
                    header,
                    reservation: (bounds.left + bounds.width + left_padding * 1.5 - header.left)
                        / scale,
                }),
            ))
        }

        fn publish(&self, fullscreen: bool, applied: Option<AppliedFrame>) -> Result<(), String> {
            let mut state = self.state.lock().expect("native frame lock poisoned");
            let mut changed = state.fullscreen != Some(fullscreen);
            state.fullscreen = Some(fullscreen);
            if let Some(applied) = applied {
                changed |= state
                    .applied
                    .map(|previous| (previous.bounds, previous.reservation))
                    != Some((applied.bounds, applied.reservation));
                state.applied = Some(applied);
            }
            drop(state);
            if changed {
                self.diagnostics.borrow_mut().state_notifications_queued += 1;
                let window = self.window.clone();
                let active = self.active.clone();
                // Only web notification is deferred; native layout has been verified before returning.
                let notification = RcBlock::new(move || {
                    if active.load(Ordering::Acquire) {
                        window
                            .emit("native-frame-changed", ())
                            .expect("native frame notification failed");
                    }
                });
                unsafe {
                    NSOperationQueue::mainQueue().addOperationWithBlock(&notification);
                }
            }
            Ok(())
        }
    }

    pub fn install(
        window: &tauri::WebviewWindow,
        state: Arc<Mutex<FrameState>>,
    ) -> Result<(), String> {
        let active = Arc::new(AtomicBool::new(true));
        let target = window.clone();
        let controller_active = active.clone();
        on_webview(window, move |native, webview| {
            let controller = Rc::new(NativeFrame {
                native: native.retain(),
                webview: webview.retain(),
                window: target,
                state,
                active: controller_active,
                updating: Cell::new(false),
                diagnostics: RefCell::new(Diagnostics::default()),
                started: Instant::now(),
            });
            controller.reconcile("startup")?;
            let center = NSNotificationCenter::defaultCenter();
            let mut observers = Vec::new();
            for (name, event) in [
                (
                    unsafe { NSWindowDidUpdateNotification },
                    "NSWindowDidUpdateNotification",
                ),
                (
                    unsafe { NSWindowDidEnterFullScreenNotification },
                    "NSWindowDidEnterFullScreenNotification",
                ),
                (
                    unsafe { NSWindowDidExitFullScreenNotification },
                    "NSWindowDidExitFullScreenNotification",
                ),
            ] {
                let controller = controller.clone();
                let callback = RcBlock::new(move |_notification: NonNull<NSNotification>| {
                    controller
                        .reconcile(event)
                        .expect("native frame synchronous reconciliation failed");
                });
                let observer = unsafe {
                    center.addObserverForName_object_queue_usingBlock(
                        Some(name),
                        Some(native),
                        None,
                        &callback,
                    )
                };
                observers.push(observer);
            }
            let cleanup_controller = controller.clone();
            let cleanup = Box::new(move || {
                cleanup_controller.active.store(false, Ordering::Release);
                unsafe {
                    for observer in observers {
                        center.removeObserver((&*observer).as_ref());
                    }
                }
                eprintln!(
                    "native-frame-diagnostics {}",
                    serde_json::to_string(&*cleanup_controller.diagnostics.borrow())
                        .expect("finite native diagnostics")
                );
            });
            let previous = INSTALLED_FRAME.with(|slot| {
                slot.replace(Some(InstalledFrame {
                    controller,
                    cleanup,
                }))
            });
            if let Some(previous) = previous {
                (previous.cleanup)();
            }
            Ok(())
        })?;
        let target = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                active.store(false, Ordering::Release);
                target
                    .app_handle()
                    .run_on_main_thread(|| {
                        let previous = INSTALLED_FRAME.with(|slot| slot.take());
                        if let Some(previous) = previous {
                            (previous.cleanup)();
                        }
                    })
                    .expect("native observer cleanup dispatch failed");
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
            let fullscreen = native.styleMask().contains(NSWindowStyleMask::FullScreen);
            let diagnostics = INSTALLED_FRAME.with(|slot| slot.borrow().as_ref().map(|installed| {
                serde_json::to_value(&*installed.controller.diagnostics.borrow()).expect("finite native diagnostics")
            }));
            let snapshot = serde_json::json!({
                "coordinateSpace": "window-logical-points-top-left", "reason": input.as_ref().map(|dom| &dom.reason),
                "window": {"left": 0.0, "top": 0.0, "width": window.size.width, "height": window.size.height},
                "webview": web, "contentView": content, "buttons": button_rects, "group": bounds,
                "header": header, "backIcon": back, "glyphs": glyphs,
                "pageZoom": unsafe { webview.pageZoom() }, "backingScale": native.backingScaleFactor(),
                "cssToLogicalScale": scale, "dom": input, "lastApplied": applied,
                "fullscreen": fullscreen, "diagnostics": diagnostics,
                "topClearance": header.map(|header| bounds.top - header.top),
                "bottomClearance": header.map(|header| header.top + header.height - bounds.top - bounds.height),
                "leftClearance": header.map(|header| bounds.left - header.left),
                "buttonCenterErrors": header.map(|header| button_rects.iter().map(|button| button.top + button.height / 2.0 - header.top - header.height / 2.0).collect::<Vec<_>>()),
                "backIconGap": back.map(|back| back.left - bounds.left - bounds.width),
            });
            eprintln!("native-frame-observed {}", snapshot);
            Ok(Observation { fullscreen, bounds, snapshot })
        })).await.map_err(|error| error.to_string())??;
        if let Some(dom) = dom {
            state.lock().expect("native frame lock poisoned").dom = Some(dom);
        }
        Ok(result)
    }
}

#[cfg(target_os = "macos")]
pub use macos::{install, observe};
