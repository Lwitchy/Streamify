import UIKit
import Capacitor

/*
 * Native tab bar for the iPhone app (Settings > Experimental >
 * "Native tab bar on iPhone").
 *
 * A real UITabBar floats over the bottom of the web view. It lives in
 * StreamifyRootViewController's view, a sibling above the web view: added
 * inside the WKWebView itself (Capacitor's root view *is* the web view) it
 * drew but never received taps.
 *
 * Looks:
 *   - built with the iOS 26 SDK (Xcode 26) on iOS 26: the system draws it,
 *     which is Liquid Glass;
 *   - otherwise: a floating rounded capsule with a dark blur material, so it
 *     still looks right with an older Xcode or on older iOS.
 *
 * The web page (js/native_tabbar.js) decides which tabs exist and when the
 * bar is shown; taps come back to it as "tabSelected" events.
 *
 * JS API (window.Capacitor.Plugins.NativeTabBar):
 *   show({ tabs: [{ id, title, icon, selectedIcon }], selected, tint })
 *        -> { height, safeBottom, visible, glass }   icons are SF Symbols;
 *           height = space the bar covers, measured from the screen bottom
 *   hide()             slide the bar away (kept, so show() is instant)
 *   select({ id })     highlight a tab without firing an event
 *   remove()           take the bar out of the view hierarchy
 * Events:
 *   tabSelected { id, reselected }   user tapped a tab
 *   layout      { height, safeBottom, visible, glass }   size changed
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

    /// Where the bar is added: the root container (set by
    /// StreamifyRootViewController), never the web view itself.
    weak var hostView: UIView?

    private var tabBar: UITabBar?
    private var tabIds: [String] = []
    private var selectedId: String?
    private var visible = false
    private var lastReportedHeight: CGFloat = -1
    private let haptics = UISelectionFeedbackGenerator()

    /// True only when this binary was built with the iOS 26 SDK *and* runs on
    /// iOS 26. An app built with an older Xcode keeps the old bar style even
    /// on iOS 26, so that case gets the hand-drawn capsule.
    static var usesSystemGlass: Bool {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { return true }
        #endif
        return false
    }

    // MARK: - JS methods

    @objc func show(_ call: CAPPluginCall) {
        let tabs = (call.getArray("tabs") ?? []).compactMap { $0 as? JSObject }
        let selected = call.getString("selected")
        let tint = call.getString("tint")

        DispatchQueue.main.async {
            guard let host = self.hostView ?? self.bridge?.viewController?.view else {
                call.reject("Web view is not ready")
                return
            }
            let bar = self.tabBar ?? self.makeTabBar(in: host)
            if !tabs.isEmpty { self.setItems(tabs, on: bar) }
            if let tint = tint, let color = UIColor(streamifyHex: tint) { bar.tintColor = color }
            self.highlight(id: selected, on: bar)
            host.layoutIfNeeded()
            self.setVisible(true, bar: bar)
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

    // MARK: - Layout (called by StreamifyRootViewController)

    func hostDidLayout() {
        guard let bar = tabBar, let host = bar.superview else { return }
        if !Self.usesSystemGlass {
            bar.layer.cornerRadius = bar.bounds.height / 2
        }
        let height = coveredHeight(bar, in: host)
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
        haptics.prepare()
        notifyListeners("tabSelected", data: ["id": id, "reselected": reselected])
    }

    // MARK: - Helpers

    private func makeTabBar(in host: UIView) -> UITabBar {
        let bar = UITabBar()
        bar.delegate = self
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.tintColor = .white
        bar.unselectedItemTintColor = UIColor(white: 1, alpha: 0.62)
        bar.overrideUserInterfaceStyle = .dark
        bar.itemPositioning = .fill
        bar.alpha = 0
        bar.isHidden = true

        if !Self.usesSystemGlass {
            // Floating capsule: blurred dark material, hairline rim, no top line.
            let appearance = UITabBarAppearance()
            appearance.configureWithDefaultBackground()
            appearance.backgroundEffect = UIBlurEffect(style: .systemThinMaterialDark)
            appearance.backgroundColor = UIColor(white: 0.1, alpha: 0.28)
            appearance.shadowColor = .clear
            appearance.shadowImage = UIImage()
            bar.standardAppearance = appearance
            bar.scrollEdgeAppearance = appearance
            bar.layer.cornerCurve = .continuous
            bar.layer.cornerRadius = 24.5
            bar.layer.borderWidth = 1 / UIScreen.main.scale
            bar.layer.borderColor = UIColor(white: 1, alpha: 0.18).cgColor
            bar.clipsToBounds = true
        }

        host.addSubview(bar)
        let guide = host.safeAreaLayoutGuide
        let fullWidth = bar.widthAnchor.constraint(equalTo: guide.widthAnchor, constant: -32)
        fullWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            bar.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            fullWidth,
            bar.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
            // Sits just above the home indicator, like the iOS 26 bars.
            bar.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: Self.usesSystemGlass ? 0 : -2)
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
        // Tags index into tabIds.
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
        let travel = (bar.superview.map { coveredHeight(bar, in: $0) } ?? 0) + 24
        let offset = CGAffineTransform(translationX: 0, y: max(travel, 120))
        if show {
            bar.isHidden = false
            bar.transform = offset
        }
        UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: 0,
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

    /// Distance from the top of the bar to the bottom of the screen.
    private func coveredHeight(_ bar: UITabBar, in host: UIView) -> CGFloat {
        let frame = bar.frame.applying(bar.transform.inverted())
        return max(0, host.bounds.height - frame.minY)
    }

    private func metrics(_ bar: UITabBar, in host: UIView) -> JSObject {
        return [
            "height": Double(coveredHeight(bar, in: host)),
            "safeBottom": Double(host.safeAreaInsets.bottom),
            "visible": visible,
            "glass": Self.usesSystemGlass
        ]
    }
}

/// Capacitor's view controller, plus the in-app plugins.
class StreamifyBridgeViewController: CAPBridgeViewController {
    let nativeTabBar = NativeTabBarPlugin()

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(nativeTabBar)
    }
}

/// The window's root: hosts the Capacitor web view full screen and native
/// chrome (the tab bar) above it. Status bar, home indicator and rotation
/// still follow the web view's controller.
class StreamifyRootViewController: UIViewController {
    let bridgeController = StreamifyBridgeViewController()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        addChild(bridgeController)
        bridgeController.view.frame = view.bounds
        bridgeController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(bridgeController.view)
        bridgeController.didMove(toParent: self)

        bridgeController.nativeTabBar.hostView = view
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        bridgeController.nativeTabBar.hostDidLayout()
    }

    override var childForStatusBarStyle: UIViewController? { bridgeController }
    override var childForStatusBarHidden: UIViewController? { bridgeController }
    override var childForHomeIndicatorAutoHidden: UIViewController? { bridgeController }
    override var childForScreenEdgesDeferringSystemGestures: UIViewController? { bridgeController }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        bridgeController.supportedInterfaceOrientations
    }
    override var shouldAutorotate: Bool { bridgeController.shouldAutorotate }
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
