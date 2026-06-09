//
//  ContextCardView.swift
//  Vita
//
//  Created by Yuuki Nishiyama on 2018/06/22.
//  Copyright © 2018 Yuuki Nishiyama. All rights reserved.
//

import UIKit
import DGCharts
import AWAREFramework

@IBDesignable class ContextCard: UIView {

    @IBOutlet weak var baseStackView: UIStackView!
    @IBOutlet weak var titleLabel: UILabel!
    @IBOutlet weak var indicatorView: UIView!
    @IBOutlet weak var activityIndicatorView: UIActivityIndicatorView!
    @IBOutlet weak var spaceView: UIView!
    @IBOutlet weak var indicatorHeightLayoutConstraint: NSLayoutConstraint!
    @IBOutlet weak var navigatorView: UIStackView!
    @IBOutlet weak var navigatorTitleButton: UIButton!
    @IBOutlet weak var backwardButton: UIButton!
    @IBOutlet weak var forwardButton: UIButton!
    
    var backwardHandler:(()->Void)?
    var forwardHandler:(()->Void)?
    var navigatorTitleButtonHandler:(()->Void)?

    /// The view loaded from ContextCard.xib (added as a subview in setup()).
    /// Exposed so subclasses with content taller than the default fixed height
    /// can switch it to Auto Layout and let content drive the card height.
    private(set) weak var nibContainerView: UIView?
    /// The fixed-height constraint applied in setup(). Subclasses may deactivate
    /// it to become self-sizing.
    private(set) var cardHeightConstraint: NSLayoutConstraint?

    var currentDate = Date()

    override init(frame:CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init(coder aCoder: NSCoder) {
        super.init(coder: aCoder)!
        setup()
    }

    func setup() {
        let view = Bundle.main.loadNibNamed("ContextCard", owner: self, options: nil)?.first as! UIView
        view.frame = self.bounds
        view.backgroundColor = .clear
        self.addSubview(view)
        self.nibContainerView = view
        self.backgroundColor = AWARETheme.card
        self.layer.cornerRadius = 16
        self.layer.borderWidth = 0.5
        self.layer.borderColor = UIColor.separator.cgColor
        self.layer.shadowColor = AWARETheme.accent.cgColor
        self.layer.shadowOpacity = 0.08
        self.layer.shadowRadius = 12
        self.layer.shadowOffset = CGSize(width: 0, height: 4)
        self.clipsToBounds = false
        baseStackView.backgroundColor = .clear
        titleLabel.font = UIFont.preferredFont(forTextStyle: .headline)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textColor = AWARETheme.ink
        navigatorTitleButton.tintColor = AWARETheme.accent
        backwardButton.tintColor = AWARETheme.accent
        forwardButton.tintColor = AWARETheme.accent

        let height = frame.height - titleLabel.frame.height - spaceView.frame.height
        indicatorHeightLayoutConstraint.isActive = false
        let heightConstraint = self.heightAnchor.constraint(equalToConstant:height)
        heightConstraint.isActive = true
        self.cardHeightConstraint = heightConstraint

        currentDate = Date()
        self.setTitleToNavigationView(with: currentDate)
    }

    /// Switches the card from its default fixed height to self-sizing: the nib
    /// container is pinned to the card with Auto Layout so the stacked content
    /// determines the card height. Without this, content taller than the fixed
    /// height overflows the card bounds and becomes untappable.
    func makeSelfSizing() {
        cardHeightConstraint?.isActive = false
        cardHeightConstraint = nil
        guard let container = nibContainerView else { return }
        container.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: self.topAnchor),
            container.bottomAnchor.constraint(equalTo: self.bottomAnchor),
            container.leadingAnchor.constraint(equalTo: self.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: self.trailingAnchor)
        ])
    }
    
    public func setTitleToNavigationView(with date:Date){
        self.currentDate = date
        let dateFormatter = DateFormatter()
        dateFormatter.dateStyle = .medium
        dateFormatter.timeStyle = .none
        let dateString = dateFormatter.string(from: date)
        navigatorTitleButton.setTitle(dateString, for: .normal)
    }
    
    public func setTitleToNavigationView(with string:String){
        navigatorTitleButton.setTitle(string, for: .normal)
    }
    
    
    @IBAction func pushedNavigatorTitleButton(_ sender: Any) {
        if let handler = navigatorTitleButtonHandler {
            handler()
        }
    }
    
    @IBAction func pushedBackwardButton(_ sender: UIButton) {
        if let handler = backwardHandler {
            handler()
        }
    }
    
    @IBAction func pushedForwardButton(_ sender: UIButton) {
        if let handler = forwardHandler {
            handler()
        }
    }
    
    
}
