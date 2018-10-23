import * as React from 'react';

import { boundsOf, computePolyline, Vector, computePolylineLength, getPointAlongPolyline } from '../diagram/geometry';
import { TransformedSvgCanvas } from '../diagram/paper';
import { PaperWidgetProps } from '../diagram/paperArea';
import { DiagramView, RenderingLayer } from '../diagram/view';
import { Link } from '../diagram/elements';

import { Debouncer } from '../viewUtils/async';
import { EventObserver } from '../viewUtils/events';

import { AuthoringKind, ValidationState } from './authoringState';
import { EditorController } from './editorController';
import { HtmlSpinner } from '../viewUtils/spinner';

export interface Props extends PaperWidgetProps {
    editor: EditorController;
    view: DiagramView;
}

const CLASS_NAME = `ontodia-states-widget`;
const WARNING_SIZE = 20;
const WARNING_MARGIN = 5;

export class StatesWidget extends React.Component<Props, {}> {
    private readonly listener = new EventObserver();
    private readonly delayedUpdate = new Debouncer();

    componentDidMount() {
        this.listenEvents();
    }

    componentDidUpdate(prevProps: Props) {
        const sameEventSources = (
            this.props.editor === prevProps.editor &&
            this.props.view === prevProps.view
        );
        if (!sameEventSources) {
            this.listener.stopListening();
            this.listenEvents();
        }
    }

    componentWillUnmount() {
        this.listener.stopListening();
    }

    private listenEvents() {
        const {editor, view} = this.props;
        this.listener.listen(editor.model.events, 'elementEvent',  ({data}) => {
            if (data.changeSize || data.changePosition) {
                this.scheduleUpdate();
            }
        });
        this.listener.listen(editor.model.events, 'linkEvent', ({data}) => {
            if (data.changeVertices) {
                this.scheduleUpdate();
            }
        });
        this.listener.listen(editor.model.events, 'changeCells', this.scheduleUpdate);
        this.listener.listen(editor.events, 'changeAuthoringState', this.scheduleUpdate);
        this.listener.listen(editor.events, 'changeTemporaryState', this.scheduleUpdate);
        this.listener.listen(editor.events, 'changeValidationState', this.scheduleUpdate);
        this.listener.listen(view.events, 'syncUpdate', ({layer}) => {
            if (layer === RenderingLayer.Editor) {
                this.delayedUpdate.runSynchronously();
            }
        });
    }

    private scheduleUpdate = () => {
        this.delayedUpdate.call(this.performUpdate);
    }

    private performUpdate = () => {
        this.forceUpdate();
    }

    private calculateLinkPath(link: Link) {
        const polyline = this.calculatePolyline(link);
        return 'M' + polyline.map(({x, y}) => `${x},${y}`).join(' L');
    }

    private calculatePolyline(link: Link) {
        const {editor, view} = this.props;

        const source = editor.model.getElement(link.sourceId);
        const target = editor.model.getElement(link.targetId);

        const route = view.getRouting(link.id);
        const verticesDefinedByUser = link.vertices || [];
        const vertices = route ? route.vertices : verticesDefinedByUser;

        return computePolyline(source, target, vertices);
    }

    private renderLinksStates() {
        const {editor} = this.props;
        return editor.model.links.map(link => {
            if (editor.temporaryState.links.has(link.data)) {
                const path = this.calculateLinkPath(link);
                return (
                    <path key={link.id} d={path} fill={'none'} stroke={'grey'} strokeWidth={5} strokeOpacity={0.5}
                        strokeDasharray={'8 8'}/>
                );
            }
            const state = (
                editor.authoringState.index.links.get(link.data) ||
                editor.authoringState.index.elements.get(link.data.sourceId) ||
                editor.authoringState.index.elements.get(link.data.targetId)
            );
            if (state) {
                const path = this.calculateLinkPath(link);
                let color: string;
                if (state.type === AuthoringKind.ChangeLink) {
                    color = state.before ? 'blue' : 'green';
                } else if (state.type === AuthoringKind.DeleteLink || state.type === AuthoringKind.DeleteElement) {
                    color = 'red';
                }
                return (
                    <path key={link.id} d={path} fill={'none'} stroke={color} strokeWidth={5} strokeOpacity={0.5} />
                );
            }
            return null;
        });
    }

    private renderValidationStatus() {
        const {editor} = this.props;
        const {validationState} = editor;

        return editor.model.links.map(link => {
            const validation = validationState.links.get(link.data);
            if (!validation) {
                return null;
            }
            const polyline = this.calculatePolyline(link);
            const style = this.getWarningPosition(polyline);
            const title = validation.errors.map(error => error.message).join('\n');

            return (<div
                className={`${CLASS_NAME}_warning`}
                key={link.id}
                style={style}
                title={title}>
                {validation.loading ?
                    <HtmlSpinner width={20} height={20}/>
                    : <div className={`${CLASS_NAME}_warning__invalid-icon`}/>
                }
                {(!validation.loading && validation.errors.length > 0)
                    ? validation.errors.length : undefined}
            </div>);
        });
    }

    private getWarningPosition(polyline: ReadonlyArray<Vector>): { top: number; left: number } {
        const point = getPointAlongPolyline(polyline, WARNING_SIZE + WARNING_MARGIN);
        const {x, y} = this.props.paperArea.paperToScrollablePaneCoords(point.x, point.y);

        return {top: y - WARNING_SIZE / 2, left: x - WARNING_SIZE / 2};
    }

    private renderElementsStates() {
        const {editor} = this.props;
        return editor.model.elements.map(element => {
            const {x, y, width, height} = boundsOf(element);
            if (editor.temporaryState.elements.has(element.iri)) {
                return (
                    <rect key={element.id} x={x} y={y} width={width} height={height} fill={'none'} stroke={'grey'}
                        strokeWidth={3} strokeOpacity={0.7} strokeDasharray={'8 8'} />
                );
            }
            const state = editor.authoringState.index.elements.get(element.iri);
            if (state) {
                const actionClass = `${CLASS_NAME}__action`;
                const cancelClass = `${CLASS_NAME}__cancel`;
                const onCancel = () => editor.discardChange(state);

                if (state.type === AuthoringKind.ChangeElement && !state.before) {
                    return <g key={element.id}>
                        <text x={x} y={y} dy='-1ex' pointerEvents='all'>
                            <tspan className={actionClass}>New</tspan> [
                                <tspan className={cancelClass}
                                    onClick={onCancel}>
                                    <title>Revert creation of the element</title>
                                    cancel
                                </tspan>
                            ]
                        </text>
                    </g>;
                } else if (state.type === AuthoringKind.ChangeElement && state.before) {
                    return <g key={element.id}>
                        <text x={x} y={y} dy='-1ex' pointerEvents='all'>
                            <tspan className={actionClass}>Change</tspan> [
                                <tspan className={cancelClass}
                                    onClick={onCancel}>
                                    <title>Revert all changes in properties of the element</title>
                                    cancel
                                </tspan>
                            ]
                        </text>
                    </g>;
                } else if (state.type === AuthoringKind.DeleteElement) {
                    const right = x + width;
                    const bottom = y + height;
                    return <g key={element.id}>
                        <text x={x} y={y} dy='-1ex' pointerEvents='all'>
                            <tspan className={actionClass}>Delete</tspan> [
                                <tspan className={cancelClass}
                                    onClick={onCancel}>
                                    <title>Revert deletion of the element</title>
                                    cancel
                                </tspan>
                            ]
                        </text>
                        <rect x={x} y={y} width={width} height={height} fill='white' fillOpacity={0.5} />
                        <line x1={x} y1={y} x2={right} y2={bottom} stroke='red' />
                        <line x1={right} y1={y} x2={x} y2={bottom} stroke='red' />
                    </g>;
                } else {
                    throw new Error('Unexpected element status');
                }
            }
            return null;
        });
    }

    render() {
        const {editor, paperTransform} = this.props;
        if (!editor.inAuthoringMode) {
            return null;
        }
        return (<div className={`${CLASS_NAME}`}>
            <TransformedSvgCanvas paperTransform={paperTransform} style={{overflow: 'visible', pointerEvents: 'none'}}>
                {this.renderLinksStates()}
                {this.renderElementsStates()}
            </TransformedSvgCanvas>
            <div className={`${CLASS_NAME}__validation-layer`}>
                {this.renderValidationStatus()}
            </div>
        </div>);
    }
}
