//
//  DeviceUsageCard.swift
//  StudyTrace
//
//  Battery screenshot app-usage workflow.
//

import UIKit
import AWAREFramework

class DeviceUsageCard: ContextCard {

    private let headlineLabel = UILabel()
    private let detailLabel = UILabel()
    private let summaryStack = UIStackView()
    private let instructionsButton = UIButton(type: .system)
    private var configureHandler: (() -> Void)?

    override func setup() {
        super.setup()
        titleLabel.text = "Battery Usage Screenshot"
        indicatorView.isHidden = true
        activityIndicatorView.isHidden = true
        navigatorView.isHidden = true

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 14
        stack.layoutMargins = UIEdgeInsets(top: 4, left: 18, bottom: 18, right: 18)
        stack.isLayoutMarginsRelativeArrangement = true

        headlineLabel.font = UIFont.preferredFont(forTextStyle: .title2)
        headlineLabel.textColor = AWARETheme.ink
        headlineLabel.adjustsFontForContentSizeCategory = true
        headlineLabel.numberOfLines = 0

        detailLabel.font = UIFont.preferredFont(forTextStyle: .footnote)
        detailLabel.textColor = AWARETheme.secondaryInk
        detailLabel.numberOfLines = 0
        detailLabel.adjustsFontForContentSizeCategory = true

        summaryStack.axis = .vertical
        summaryStack.spacing = 8

        instructionsButton.setTitle(" How to upload Battery screenshot", for: .normal)
        instructionsButton.setImage(UIImage(systemName: "camera.viewfinder"), for: .normal)
        instructionsButton.tintColor = AWARETheme.accent
        instructionsButton.backgroundColor = AWARETheme.accent.withAlphaComponent(0.12)
        instructionsButton.layer.cornerRadius = 14
        instructionsButton.contentEdgeInsets = UIEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        instructionsButton.addTarget(self, action: #selector(didTapInstructions), for: .touchUpInside)

        stack.addArrangedSubview(headlineLabel)
        stack.addArrangedSubview(detailLabel)
        stack.addArrangedSubview(summaryStack)
        stack.addArrangedSubview(instructionsButton)

        baseStackView.insertArrangedSubview(stack, at: 2)
        makeSelfSizing()
        refresh()
    }

    func configure(sensor: AWARESensor?,
                   configureHandler: @escaping () -> Void,
                   reportHandler: (() -> Void)? = nil) {
        self.configureHandler = configureHandler
        refresh()
    }

    func refresh() {
        headlineLabel.text = "Upload when prompted"
        detailLabel.text = "If your study asks for app-usage context, complete the Battery usage screenshot survey. StudyTrace collects this only from participant-submitted screenshots."
        refreshSummaryRows()
    }

    @objc private func didTapInstructions() {
        configureHandler?()
    }

    private func refreshSummaryRows() {
        summaryStack.arrangedSubviews.forEach { view in
            summaryStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        summaryStack.addArrangedSubview(summaryRow(text: "1. Open iPhone Settings > Battery."))
        summaryStack.addArrangedSubview(summaryRow(text: "2. Tap View All Battery Usage so app rows and usage values are visible."))
        summaryStack.addArrangedSubview(summaryRow(text: "3. Take a screenshot and upload it in the Battery usage screenshot survey."))
    }

    private func summaryRow(text: String) -> UIView {
        let label = UILabel()
        label.font = UIFont.preferredFont(forTextStyle: .caption1)
        label.textColor = AWARETheme.secondaryInk
        label.numberOfLines = 0
        label.adjustsFontForContentSizeCategory = true
        label.text = text

        let container = UIView()
        container.backgroundColor = AWARETheme.accent.withAlphaComponent(0.08)
        container.layer.cornerRadius = 10
        container.translatesAutoresizingMaskIntoConstraints = false

        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10)
        ])
        return container
    }
}
