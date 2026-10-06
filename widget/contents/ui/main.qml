// SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
// SPDX-License-Identifier: GPL-3.0-or-later

// Kwilt Pile — the minimized windows on this widget's screen, the current
// virtual desktop and the current activity, one click to bring each back.
//
// Kwilt minimizes ("knocks out") windows past a layout's cap; this lists
// them. No IPC with the KWin script is needed: activating a window through
// TasksModel.requestActivate fires KWin's windowActivated, and Kwilt's
// onActivated already promotes a knocked-out window back into the visible
// tiles. Windows the user minimized by hand show up too — on a Kwilt
// screen they are indistinguishable from knocked-out ones.

pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts

import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.extras as PlasmaExtras
import org.kde.kirigami as Kirigami
import org.kde.taskmanager as TaskManager

PlasmoidItem {
    id: root

    readonly property int pileCount: tasksModel.count
    readonly property url logo: Qt.resolvedUrl("../images/kwilt-logo.png")
    readonly property bool inPanel: Plasmoid.formFactor === PlasmaCore.Types.Horizontal
                                 || Plasmoid.formFactor === PlasmaCore.Types.Vertical

    // In a panel: the logo with a count badge, list in a popup. On the
    // desktop there's room, so show the list directly.
    preferredRepresentation: inPanel ? compactRepresentation : fullRepresentation

    // Empty pile: dim in a panel, and let the system tray hide it.
    Plasmoid.status: pileCount > 0 ? PlasmaCore.Types.ActiveStatus : PlasmaCore.Types.PassiveStatus
    Plasmoid.icon: "view-grid"

    toolTipMainText: i18n("Kwilt Pile")
    toolTipSubText: pileCount > 0
        ? i18np("%1 minimized window", "%1 minimized windows", pileCount)
        : i18n("No minimized windows")

    TaskManager.VirtualDesktopInfo { id: virtualDesktopInfo }
    TaskManager.ActivityInfo { id: activityInfo }

    TaskManager.TasksModel {
        id: tasksModel

        // Same scope as a Kwilt queue: one (output, virtualDesktop), plus
        // the current activity.
        filterByScreen: true
        screenGeometry: Plasmoid.containment.screenGeometry
        filterByVirtualDesktop: true
        virtualDesktop: virtualDesktopInfo.currentDesktop
        filterByActivity: true
        activity: activityInfo.currentActivity

        filterNotMinimized: true
        filterHidden: true
        groupMode: TaskManager.TasksModel.GroupDisabled
        sortMode: TaskManager.TasksModel.SortLastActivated
    }

    function restore(index) {
        tasksModel.requestActivate(tasksModel.makeModelIndex(index));
        if (inPanel) root.expanded = false;
    }

    compactRepresentation: MouseArea {
        id: compact

        hoverEnabled: true
        acceptedButtons: Qt.LeftButton
        onClicked: root.expanded = !root.expanded

        Kirigami.Icon {
            id: icon
            anchors.fill: parent
            source: root.logo
            active: compact.containsMouse
            opacity: root.pileCount > 0 ? 1 : 0.5
        }

        Rectangle {
            visible: root.pileCount > 0
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: Math.max(badgeLabel.implicitHeight, Kirigami.Units.iconSizes.small * 0.75)
            width: Math.max(height, badgeLabel.implicitWidth + Kirigami.Units.smallSpacing)
            radius: height / 2
            color: Kirigami.Theme.highlightColor

            PlasmaComponents.Label {
                id: badgeLabel
                anchors.centerIn: parent
                text: root.pileCount > 99 ? "99+" : root.pileCount
                color: Kirigami.Theme.highlightedTextColor
                font.pixelSize: Math.round(parent.height * 0.7)
                font.bold: true
            }
        }
    }

    fullRepresentation: PlasmaExtras.Representation {
        Layout.minimumWidth: Kirigami.Units.gridUnit * 14
        Layout.minimumHeight: Kirigami.Units.gridUnit * 8
        Layout.preferredWidth: Kirigami.Units.gridUnit * 18
        Layout.preferredHeight: Kirigami.Units.gridUnit * 16

        collapseMarginsHint: true

        header: PlasmaExtras.PlasmoidHeading {
            RowLayout {
                anchors.fill: parent
                spacing: Kirigami.Units.smallSpacing

                Kirigami.Icon {
                    source: root.logo
                    Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                    Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
                }
                Kirigami.Heading {
                    Layout.fillWidth: true
                    level: 3
                    text: i18n("Kwilt Pile")
                    elide: Text.ElideRight
                }
                PlasmaComponents.Label {
                    visible: root.pileCount > 0
                    text: root.pileCount
                    opacity: 0.7
                }
            }
        }

        PlasmaComponents.ScrollView {
            anchors.fill: parent

            ListView {
                id: list

                model: tasksModel
                clip: true
                reuseItems: true
                highlight: PlasmaExtras.Highlight {}
                highlightMoveDuration: 0
                currentIndex: -1

                delegate: PlasmaComponents.ItemDelegate {
                    id: taskDelegate
                    required property int index
                    required property var model

                    width: ListView.view.width
                    text: model.display
                    icon.name: ""
                    hoverEnabled: true
                    onHoveredChanged: if (hovered) ListView.view.currentIndex = index

                    contentItem: RowLayout {
                        spacing: Kirigami.Units.smallSpacing
                        Kirigami.Icon {
                            source: taskDelegate.model.decoration
                            Layout.preferredWidth: Kirigami.Units.iconSizes.medium
                            Layout.preferredHeight: Kirigami.Units.iconSizes.medium
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 0
                            PlasmaComponents.Label {
                                Layout.fillWidth: true
                                text: taskDelegate.model.display
                                elide: Text.ElideRight
                            }
                            PlasmaComponents.Label {
                                Layout.fillWidth: true
                                visible: text.length > 0 && text !== taskDelegate.model.display
                                text: taskDelegate.model.AppName || ""
                                elide: Text.ElideRight
                                opacity: 0.7
                                font: Kirigami.Theme.smallFont
                            }
                        }
                    }

                    onClicked: root.restore(index)
                }

                PlasmaExtras.PlaceholderMessage {
                    anchors.centerIn: parent
                    width: parent.width - Kirigami.Units.gridUnit * 2
                    visible: list.count === 0
                    iconName: "view-grid"
                    text: i18n("Nothing in the pile")
                    explanation: i18n("Windows Kwilt minimizes past a layout's cap, or that you minimize yourself, show up here.")
                }
            }
        }
    }
}
