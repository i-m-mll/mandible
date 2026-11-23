import AppKit

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.finishLaunching()
application.activate()

let panel = NSOpenPanel()
panel.title = "Add project"
panel.prompt = "Add"
panel.canChooseFiles = false
panel.canChooseDirectories = true
panel.allowsMultipleSelection = false

let selectedPath = panel.runModal() == .OK ? panel.url?.path : nil
let answer = try JSONEncoder().encode(selectedPath)
FileHandle.standardOutput.write(answer)
