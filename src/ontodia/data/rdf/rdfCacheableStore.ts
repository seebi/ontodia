import { RDFStore, RDFGraph, createStore, createGraph, Node, Literal, NamedNode, Triple } from 'rdf-ext';
import 'whatwg-fetch';
import { Dictionary } from '../model';
import { RDFCompositeParser } from './rdfCompositeParser';

import { uniqueId } from 'lodash';

const DEFAULT_STOREG_TYPE = 'text/turtle';
const DEFAULT_STOREG_URI = 'https://ontodia.org/localData.rdf';

export function PrefixFactory(prefix: string): ((id: string) => string) {
    const lastSymbol = prefix[prefix.length - 1];
    const _prefix = lastSymbol === '/' || lastSymbol === '#' ? prefix : prefix + '/';
    return (id: string) => {
        return _prefix + id;
    };
}

export interface RDFStore {
    add: (id: string, graph: RDFGraph) => void;
    match: (
        subject?: string,
        predicat?: string,
        object?: string,
        iri?: string,
        callback?: (result: any) => void,
        limit?: number,
    ) => Promise<RDFGraph>;
}

export function isLiteral(el: Node): el is Literal {
    return el.interfaceName === 'Literal';
}

export function isNamedNode(el: Node): el is NamedNode {
    return el.interfaceName === 'NamedNode';
}

export type MatchStatement = {
    subject?: string,
    predicate?: string,
    object?: string,
    iri?: string,
    callback?: (...args: any[]) => void,
    limit?: number,
};

export const LABEL_URIS = [
    'http://www.w3.org/2004/02/skos/core#prefLabel',
    'http://www.w3.org/2004/02/skos/core#label',
    'http://www.w3.org/2004/02/skos/core#altLabel',
    'http://www.w3.org/2000/01/rdf-schema#prefLabel',
    'http://www.w3.org/2000/01/rdf-schema#label',
    'http://xmlns.com/foaf/0.1/name',
    'http://schema.org/name',
];

export const LABEL_POSTFIXES = [
    'prefLabel',
    'prefName',
    'label',
    'name',
    'title',
];

export class RDFCacheableStore {
    private rdfStorage: RDFStore;
    private checkingElementMap: Dictionary<Promise<boolean>> = {};
    private labelsMap: Dictionary<Triple[]> = {};
    private countMap: Dictionary<number> = {};
    private elementTypes: Dictionary<Triple[]> = {};
    private prefs: { [id: string]: (id: string) => string };
    constructor(
        private parser: RDFCompositeParser,
    ) {
        this.rdfStorage = createStore ();
        this.prefs = {
            RDF: PrefixFactory('http://www.w3.org/1999/02/22-rdf-syntax-ns#'),
            RDFS: PrefixFactory('http://www.w3.org/2000/01/rdf-schema#'),
            FOAF: PrefixFactory('http://xmlns.com/foaf/0.1/'),
            XSD: PrefixFactory('http://www.w3.org/2001/XMLSchema#'),
            OWL: PrefixFactory('http://www.w3.org/2002/07/owl#'),
        };
    }

    add(rdfGraph: RDFGraph, prefix?: string) {
        this.rdfStorage.add(uniqueId(prefix) || (uniqueId(DEFAULT_STOREG_URI)), rdfGraph);
        this.enrichMaps(rdfGraph);
    }

    match(
        subject?: string,
        predicate?: string,
        object?: string,
        iri?: string,
        callback?: (...args: any[]) => void,
        limit?: number,
    ): Promise<RDFGraph> {
        if (subject && (LABEL_URIS.indexOf(predicate) !== -1) && !object) {
            return Promise.resolve(this._getLabels(subject));
        } else if (subject && predicate === this.prefs.RDF('type') && !object) {
            return Promise.resolve(this.getTypes(subject));
        } else {
            return this.rdfStorage.match(
                subject,
                predicate,
                object,
                iri,
                callback,
                limit,
            );
        }
    }

    matchAll(statements: MatchStatement[]): Promise<RDFGraph> {
        const slowQueries: MatchStatement[] = [];
        const queries: RDFGraph[] = [];
        
        statements.forEach(statement => {
            if (statement.subject && (LABEL_URIS.indexOf(statement.predicate) !== -1) && !statement.object) {
                queries.push(this._getLabels(statement.subject));
            } else if (statement.subject && statement.predicate === this.prefs.RDF('type') && !statement.object) {
                queries.push(this.getTypes(statement.subject));
            } else {
                slowQueries.push(statement);
            }
        });
        
        queries.push(this.multipleMatch(slowQueries));

        return Promise.resolve(this.combineGraphs(queries));
    }

    getLabels(id: string): Promise<RDFGraph> {
        return Promise.resolve(createGraph(this.labelsMap[id]));
    }

    // Checks whetger the element is in the storage.
    checkElement(id: string): Promise<boolean> {
        if (this.labelsMap[id]) { // if there is label for an id then the element is already fetched
            return Promise.resolve(true);
        } else {
            if (!this.checkingElementMap[id]) {
                this.checkingElementMap[id] = this.rdfStorage.match(id, null, null).then(result => {
                    const resultArray = result.toArray();
                    if (resultArray.length === 0) {
                        return false;
                    } else {
                        return true;
                    }
                });
                return this.checkingElementMap[id];
            } else {
                return this.checkingElementMap[id];
            }
        }
    }

    getTypeCount(id: string): number {
        return this.countMap[id] || 0;
    }

    private enrichMaps(newGraph: RDFGraph): boolean {
        const triples = newGraph.toArray();

        for (const triple of triples) {
            const element = triple.subject.nominalValue;
            const predicate = triple.predicate.nominalValue;
            if (
                LABEL_URIS.indexOf(predicate) !== -1 ||
                (
                    !this.labelsMap[element] &&
                    LABEL_POSTFIXES.find((value, index, array) => {
                        const type = predicate.toLocaleLowerCase();
                        const postfix = value.toLocaleLowerCase();
                        return type.indexOf(postfix) !== -1;
                    })
                )
            ) {
                if (!this.labelsMap[element]) {
                    this.labelsMap[element] = [];
                }
                if (isLiteral(triple.object)) {
                    this.labelsMap[element].push(triple);
                    this.labelsMap[element].sort((a, b) => {
                        const index1 = LABEL_URIS.indexOf(a.predicate.nominalValue);
                        const index2 = LABEL_URIS.indexOf(b.predicate.nominalValue);
                        if (index1 > index2) {
                            return 1;
                        } else if (index1 < index2) {
                            return -1;
                        } else {
                            return 0;
                        }
                    });
                }
            }
        }

        const typeInstances = newGraph.match(
            null,
            this.prefs.RDF('type'),
            null,
        ).toArray();
        const typeInstMap: Dictionary<string[]> = {};
        for (const instTriple of typeInstances) {
            const type = instTriple.object.nominalValue;
            const inst = instTriple.subject.nominalValue;
            if (!typeInstMap[type]) {
                typeInstMap[type] = [];
            }
            if (!this.elementTypes[inst]) {
                this.elementTypes[inst] = [];
            }
            if (typeInstMap[type].indexOf(inst) === -1) {
                typeInstMap[type].push(inst);
            }
            this.elementTypes[inst].push(instTriple);
        }
        Object.keys(typeInstMap).forEach(key => this.countMap[key] = typeInstMap[key].length);

        return true;
    }

    private _getLabels(id: string): RDFGraph {
        return createGraph(this.labelsMap[id]);
    }

    private getTypes(id: string): RDFGraph {
        return createGraph(this.elementTypes[id]);
    }

    private combineGraphs(graphs: RDFGraph[]): RDFGraph {
        const triples: Triple[] = [];
        for (const graph of graphs) {
            for (const triple of graph.toArray()) {
                triples.push(triple);
            };
        };
        return createGraph(triples);
    }

    private multipleMatch(statements: MatchStatement[]): RDFGraph {
        const triples: Triple[] = [];
        const graphs = Object.keys(this.rdfStorage.graphs).map(id => this.rdfStorage.graphs[id]);
        for (const graph of graphs) {
            for (const triple of graph._graph) {
                for(const statement of statements) {
                    if (
                        ((!statement.object) || statement.object === triple.object.nominalValue) &&
                        ((!statement.predicate) || statement.predicate === triple.predicate.nominalValue) &&
                        ((!statement.subject) || statement.subject === triple.subject.nominalValue)
                    ) {
                        triples.push(triple);
                        continue;
                    }
                };
            };
        };
        return createGraph(triples);
    }
}

export default RDFCacheableStore;

function fetchFile(params: {
    url: string,
    headers?: any,
}) {
    return fetch(
        '/lod-proxy/' + params.url,
        {
            method: 'GET',
            credentials: 'same-origin',
            mode: 'cors',
            cache: 'default',
            headers: params.headers || {
                'Accept': 'application/rdf+xml',
            },
        },
    ).then(response => {
        if (response.ok) {
            return response.text();
        } else {
            const error = new Error(response.statusText);
            (<any> error).response = response;
            console.error(error);
            return undefined;
        }
    }).catch(error => {
        console.error(error);
        return undefined;
    });
}
