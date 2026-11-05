import UIKit
import Capacitor

/*
 * Native tab bar for the iPhone app (Settings > Experimental >
 * "Native tab bar on iPhone").
 *
 * A real UITabBar is laid over the bottom of the web view. Built with the
 * iOS 26 SDK it is drawn by the system as Liquid Glass; on older iOS it is
 * the standard translucent bar. The web page (js/native_tabbar.js) decides
 * which tabs exist and when the bar is shown; taps come back to it as
 * "tabSelected" events.
 *
 * JS API (window.Capacitor.Plugins.NativeTabBar):
 *   show({ tabs: [{ id, title, icon, selectedIcon }], selected, tint })
 *        -> { height, safeBottom }   icon names are SF Symbols
 *   hide()             slide the bar away (kept, so show() is instant)
 *   select({ id })     highlight a tab without firing an event
 *   remove()           take the bar out of the view hierarchy
 * Events:
 *   tabSelected { id, reselected }   user tapped a tab
 *   layout      { height, safeBottom, visible }   bar size changed
 */
@objc(NativeTabBarPlugin)
public class NativeTabBarPlugin: CAPPlugin, CAPBridgedPlugin, UITabBarDelegate {
    public let identifier = "NativeTabBarPlugin"
    public let jsName = "NativeTabBar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "select", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private var tabBar: UITabBar?
    private var tabIds: [String] = []
    private var selectedId: String?
    private var visible = false
    private var lastReportedHeight: CGFloat = -1
    private let haptics = UISelectionFeedbackGenerator()

    // MARK: - JS methods

    @objc func show(_ call: CAPPluginCall) {
        let tabs = (call.getArray("tabs") ?? []).compactMap { $0 as? JSObject }
        let selected = call.getString("selected")
        let tint = call.getString("tint")

        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController?.view else {
                call.reject("Web view is not ready")
                return
            }
            let bar = self.tabBar ?? self.makeTabBar(in: host)
            if !tabs.isEmpty { self.setItems(tabs, on: bar) }
            if let tint = tint, let color = UIColor(streamifyHex: tint) { bar.tintColor = color }
            self.highlight(id: selected, on: bar)
            self.setVisible(true, bar: bar)
            host.layoutIfNeeded()
            call.resolve(self.metrics(bar, in: host))
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let bar = self.tabBar { self.setVisible(false, bar: bar) }
            call.resolve()
        }
    }

    @objc func select(_ call: CAPPluginCall) {
        let id = call.getString("id")
        DispatchQueue.main.async {
            if let bar = self.tabBar { self.highlight(id: id, on: bar) }
            call.resolve()
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.tabBar?.removeFromSuperview()
            self.tabBar = nil
            self.tabIds = []
            self.selectedId = nil
            self.visible = false
            self.lastReportedHeight = -1
            call.resolve()
        }
    }

    // MARK: - Layout (called by StreamifyBridgeViewController)

    func hostDidLayout() {
        guard let bar = tabBar, let host = bar.superview else { return }
        let height = bar.frame.height
        guard abs(height - lastReportedHeight) > 0.5 else { return }
        lastReportedHeight = height
        notifyListeners("layout", data: metrics(bar, in: host))
    }

    // MARK: - UITabBarDelegate

    public func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard item.tag >= 0, item.tag < tabIds.count else { return }
        let id = tabIds[item.tag]
        let reselected = (selectedId == id)
        selectedId = id
        haptics.selectionChanged()
        notifyListeners("tabSelected", data: ["id": id, "reselected": reselected])
    }

    // MARK: - Helpers

    private func makeTabBar(in host: UIView) -> UITabBar {
        let bar = UITabBar()
        bar.delegate = self
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.tintColor = .white
        bar.unselectedItemTintColor = UIColor(white: 1, alpha: 0.6)
        bar.overrideUserInterfaceStyle = .dark
        bar.alpha = 0
        bar.isHidden = true

        if #available(iOS 26.0, *) {
            // Leave the system appearance alone: that is the Liquid Glass.
        } else {
            let appearance = UITabBarAppearance()
            appearance.configureWithDefaultBackground()
            appearance.backgroundEffect = UIBlurEffect(style: .systemChromeMaterialDark)
            bar.standardAppearance = appearance
            bar.scrollEdgeAppearance = appearance
        }

        host.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
        tabBar = bar
        haptics.prepare()
        return bar
    }

    private func setItems(_ tabs: [JSObject], on bar: UITabBar) {
        var ids: [String] = []
        var items: [UITabBarItem] = []
        for tab in tabs {
            guard let id = tab["id"] as? String else { continue }
            let title = tab["title"] as? String ?? id
            let icon = (tab["icon"] as? String).flatMap { UIImage(systemName: $0) }
            let selectedIcon = (tab["selectedIcon"] as? String).flatMap { UIImage(systemName: $0) } ?? icon
            let item = UITabBarItem(title: title, image: icon, selectedImage: selectedIcon)
            item.accessibilityIdentifier = "native-tab-\(id)"
            ids.append(id)
            items.append(item)
        }
        // Tags index into tabIds, so keep them aligned even if a tab was skipped.
        for (index, item) in items.enumerated() { item.tag = index }
        tabIds = ids
        bar.setItems(items, animated: bar.items != nil)
    }

    private func highlight(id: String?, on bar: UITabBar) {
        guard let id = id, let index = tabIds.firstIndex(of: id) else {
            bar.selectedItem = nil
            selectedId = nil
            return
        }
        bar.selectedItem = bar.items?[index]
        selectedId = id
    }

    private func setVisible(_ show: Bool, bar: UITabBar) {
        guard show != visible else { return }
        visible = show
        let offset = CGAffineTransform(translationX: 0, y: max(bar.frame.height, 90))
        if show {
            bar.isHidden = false
            bar.transform = offset
        }
        UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0,
                       options: [.beginFromCurrentState, .allowUserInteraction]) {
            bar.alpha = show ? 1 : 0
            bar.transform = show ? .identity : offset
        } completion: { _ in
            if !self.visible { bar.isHidden = true }
        }
        if let host = bar.superview {
            notifyListeners("layout", data: metrics(bar, in: host))
        }
    }

    private func metrics(_ bar: UITabBar, in host: UIView) -> JSObject {
        return [
            "height": Double(bar.frame.height),
            "safeBottom": Double(host.safeAreaInsets.bottom),
            "visible": visible
        ]
    }
}

/// The app's root view controller: Capacitor's, plus the in-app plugins.
class StreamifyBridgeViewController: CAPBridgeViewController {
    let nativeTabBar = NativeTabBarPlugin()

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(nativeTabBar)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        nativeTabBar.hostDidLayout()
    }
}

private extension UIColor {
    /// "#rrggbb" or "rrggbb"
    convenience init?(streamifyHex hex: String) {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return nil }
        self.init(red: CGFloat((rgb >> 16) & 0xff) / 255,
                  green: CGFloat((rgb >> 8) & 0xff) / 255,
                  blue: CGFloat(rgb & 0xff) / 255,
                  alpha: 1)
    }
}
