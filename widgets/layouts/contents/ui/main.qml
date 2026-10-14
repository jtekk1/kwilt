// SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

// Kwilt Layouts — pick the tiling layout with a click instead of a shortcut.
//
// A KWin script can't take calls from outside, but its shortcuts can: every
// layout is registered as a global shortcut on KWin's kglobalaccel
// component, and invokeShortcut runs it exactly as the key would. Kwilt
// applies it to the focused window's screen and desktop, or, when the focus
// is in Plasma (this popup), to the active screen and current desktop.

pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts

import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.extras as PlasmaExtras
import org.kde.plasma.workspace.dbus as DBus
import org.kde.kirigami as Kirigami

PlasmoidItem {
    id: root

    readonly property bool inPanel: Plasmoid.formFactor === PlasmaCore.Types.Horizontal
                                 || Plasmoid.formFactor === PlasmaCore.Types.Vertical

    preferredRepresentation: inPanel ? compactRepresentation : fullRepresentation
    Plasmoid.icon: "view-grid"

    toolTipMainText: i18n("Kwilt Layouts")
    toolTipSubText: i18n("Choose the tiling layout for this screen and desktop")

    // `id` is the kglobalaccel action registered by Kwilt's main.js (its
    // LAYOUTS[...].shortcutId, frozen there). `tiles` sketches the layout
    // with three windows as [x, y, width, height] fractions; the first is
    // the master.
    readonly property var layouts: [
        { id: "KwiltLayoutGrid",           label: i18n("Auto Grid"),       tiles: [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]] },
        { id: "KwiltLayoutCenter",         label: i18n("Center Tile"),     tiles: [[.25, 0, .5, 1], [0, 0, .25, 1], [.75, 0, .25, 1]] },
        { id: "KwiltLayoutVerticalCenter", label: i18n("Vertical Center"), tiles: [[0, .25, 1, .5], [0, 0, 1, .25], [0, .75, 1, .25]] },
        { id: "KwiltLayoutMonocle",        label: i18n("Monocle"),         tiles: [[0, 0, 1, 1]] },
        { id: "KwiltLayoutDual",           label: i18n("Dual"),            tiles: [[0, 0, .5, 1], [.5, 0, .5, 1]] },
        { id: "KwiltLayoutVerticalDual",   label: i18n("Vertical Dual"),   tiles: [[0, 0, 1, .5], [0, .5, 1, .5]] },
        { id: "KwiltLayoutLeft",           label: i18n("Left Tile"),       tiles: [[0, 0, .5, 1], [.5, 0, .5, .5], [.5, .5, .5, .5]] },
        { id: "KwiltLayoutRight",          label: i18n("Right Tile"),      tiles: [[.5, 0, .5, 1], [0, 0, .5, .5], [0, .5, .5, .5]] },
        { id: "KwiltLayoutTop",            label: i18n("Top Tile"),        tiles: [[0, 0, 1, .5], [0, .5, .5, .5], [.5, .5, .5, .5]] },
        { id: "KwiltLayoutBottom",         label: i18n("Bottom Tile"),     tiles: [[0, .5, 1, .5], [0, 0, .5, .5], [.5, 0, .5, .5]] },
        { id: "KwiltLayoutFloating",       label: i18n("Floating"),        tiles: [[.1, .1, .55, .55], [.35, .35, .55, .55]] }
    ]

    function apply(shortcutId) {
        const reply = DBus.SessionBus.asyncCall({
            service: "org.kde.kglobalaccel",
            path: "/component/kwin",
            iface: "org.kde.kglobalaccel.Component",
            member: "invokeShortcut",
            arguments: [shortcutId],
        }) as DBus.DBusPendingReply;
        // Release the reply once it lands; a connected signal otherwise
        // keeps it alive.
        reply.finished.connect(() => reply.destroy());
        if (inPanel) root.expanded = false;
    }

    compactRepresentation: MouseArea {
        id: compact

        hoverEnabled: true
        acceptedButtons: Qt.LeftButton
        onClicked: root.expanded = !root.expanded

        Kirigami.Icon {
            anchors.fill: parent
            source: Plasmoid.icon
            active: compact.containsMouse
        }
    }

    // A miniature of the layout: the master in the highlight color, the
    // rest in the text color.
    component Preview: Item {
        id: preview
        required property var tiles

        Repeater {
            model: preview.tiles
            delegate: Rectangle {
                required property var modelData
                required property int index
                readonly property int gap: 1

                x: modelData[0] * preview.width + gap
                y: modelData[1] * preview.height + gap
                width: modelData[2] * preview.width - 2 * gap
                height: modelData[3] * preview.height - 2 * gap
                radius: 2
                color: index === 0 ? Kirigami.Theme.highlightColor : Kirigami.Theme.textColor
                opacity: index === 0 ? 0.9 : 0.35
                border.width: 1
                border.color: Kirigami.Theme.backgroundColor
            }
        }
    }

    fullRepresentation: PlasmaExtras.Representation {
        Layout.minimumWidth: Kirigami.Units.gridUnit * 12
        Layout.minimumHeight: Kirigami.Units.gridUnit * 10
        Layout.preferredWidth: Kirigami.Units.gridUnit * 14
        Layout.preferredHeight: list.contentHeight + header.implicitHeight

        collapseMarginsHint: true

        header: PlasmaExtras.PlasmoidHeading {
            Kirigami.Heading {
                anchors.fill: parent
                level: 3
                text: i18n("Kwilt Layouts")
                elide: Text.ElideRight
            }
        }

        PlasmaComponents.ScrollView {
            anchors.fill: parent

            ListView {
                id: list

                model: root.layouts
                clip: true
                highlight: PlasmaExtras.Highlight {}
                highlightMoveDuration: 0
                currentIndex: -1

                delegate: PlasmaComponents.ItemDelegate {
                    id: layoutDelegate
                    required property int index
                    required property var modelData

                    width: ListView.view.width
                    text: modelData.label
                    hoverEnabled: true
                    onHoveredChanged: if (hovered) ListView.view.currentIndex = index

                    contentItem: RowLayout {
                        spacing: Kirigami.Units.largeSpacing
                        Preview {
                            tiles: layoutDelegate.modelData.tiles
                            Layout.preferredWidth: Kirigami.Units.iconSizes.medium * 1.6
                            Layout.preferredHeight: Kirigami.Units.iconSizes.medium
                        }
                        PlasmaComponents.Label {
                            Layout.fillWidth: true
                            text: layoutDelegate.modelData.label
                            elide: Text.ElideRight
                        }
                    }

                    onClicked: root.apply(modelData.id)
                }
            }
        }
    }
}
