import { FieldsByTypeName, ResolveTree } from "graphql-parse-resolve-info";
import { ConnectionField, ConnectionOptionsArg, ConnectionWhereArg, Context } from "../../types";
import { Node } from "../../classes";
import createProjectionAndParams from "../create-projection-and-params";
import Relationship from "../../classes/Relationship";
import createRelationshipPropertyElement from "../projection/elements/create-relationship-property-element";
import createConnectionWhereAndParams from "../where/create-connection-where-and-params";

/*
input:

{
    actorsConnection: {
        alias: "actorsConnection"
        name: "actorsConnection"
        args: { where, options }????
        fieldsByTypeName: {
            MovieActorsConnection: {
                edges: {
                    alias: "edges"
                    name: "edges"
                    args: { }
                    fieldsByTypeName: {
                        MovieActorsRelationship: {
                            screenTime: {
                                alias: "screenTime"
                                name: "screenTime"
                            }
                            node: {
                                alias: "node"
                                name: "node"
                                fieldsByTypeName: {   PASS ME BACK TO create-projection-and-params
                                    ..........
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

output:

actorsConnection: apoc.cypher.runFirstColumn(
    "
      MATCH (this)<-[this_acted_in:ACTED_IN]-(this_actors:Actor)
      WITH collect({ screenTime: this_acted_in.screenTime, node: { name: this_actors.name }}) as edges
      RETURN { edges: edges }
    ",
    {this: this},
    true
  )

*/
function createConnectionAndParams({
    resolveTree,
    field,
    context,
    nodeVariable,
    parameterPrefix,
}: {
    resolveTree: ResolveTree;
    field: ConnectionField;
    context: Context;
    nodeVariable: string;
    parameterPrefix?: string;
}): [string, any] {
    let legacyProjectionWhereParams;
    let nestedConnectionFieldParams;

    const subquery = ["CALL {", `WITH ${nodeVariable}`];

    const sortInput = (resolveTree.args.options as ConnectionOptionsArg)?.sort;
    const whereInput = resolveTree.args.where as ConnectionWhereArg;

    const relationshipVariable = `${nodeVariable}_${field.relationship.type.toLowerCase()}`;
    const relationship = context.neoSchema.relationships.find(
        (r) => r.name === field.relationshipTypeName
    ) as Relationship;

    const inStr = field.relationship.direction === "IN" ? "<-" : "-";
    const relTypeStr = `[${relationshipVariable}:${field.relationship.type}]`;
    const outStr = field.relationship.direction === "OUT" ? "->" : "-";

    const connection = resolveTree.fieldsByTypeName[field.typeMeta.name];
    const { edges } = connection;

    const relationshipFieldsByTypeName = edges.fieldsByTypeName[field.relationshipTypeName];

    const relationshipProperties = Object.values(relationshipFieldsByTypeName).filter((v) => v.name !== "node");
    const node = Object.values(relationshipFieldsByTypeName).find((v) => v.name === "node") as ResolveTree;

    const elementsToCollect: string[] = [];

    if (relationshipProperties.length) {
        const relationshipPropertyEntries = relationshipProperties.map((v) =>
            createRelationshipPropertyElement({ resolveTree: v, relationship, relationshipVariable })
        );
        elementsToCollect.push(relationshipPropertyEntries.join(", "));
    }

    if (field.relationship.union) {
        const unionNodes = context.neoSchema.nodes.filter((n) => field.relationship.union?.nodes?.includes(n.name));
        const unionSubqueries: string[] = [];

        unionNodes.forEach((n) => {
            const relatedNodeVariable = `${nodeVariable}_${n.name}`;
            const nodeOutStr = `(${relatedNodeVariable}:${n.name})`;

            const unionSubquery: string[] = [];
            const unionSubqueryElementsToCollect = [...elementsToCollect];

            const nestedSubqueries: string[] = [];

            if (node) {
                // Doing this for unions isn't necessary, but this would also work for interfaces if we decided to take that direction
                const nodeFieldsByTypeName: FieldsByTypeName = {
                    [n.name]: {
                        ...node?.fieldsByTypeName[n.name],
                        ...node?.fieldsByTypeName[field.relationship.typeMeta.name],
                    },
                };

                const nodeProjectionAndParams = createProjectionAndParams({
                    fieldsByTypeName: nodeFieldsByTypeName,
                    node: n,
                    context,
                    varName: relatedNodeVariable,
                    literalElements: true,
                    resolveType: true,
                });
                const [nodeProjection, nodeProjectionParams] = nodeProjectionAndParams;
                unionSubqueryElementsToCollect.push(`node: ${nodeProjection}`);
                legacyProjectionWhereParams = nodeProjectionParams;

                if (nodeProjectionAndParams[2]?.connectionFields?.length) {
                    nodeProjectionAndParams[2].connectionFields.forEach((connectionResolveTree) => {
                        const connectionField = n.connectionFields.find(
                            (x) => x.fieldName === connectionResolveTree.name
                        ) as ConnectionField;
                        const nestedConnection = createConnectionAndParams({
                            resolveTree: connectionResolveTree,
                            field: connectionField,
                            context,
                            nodeVariable: relatedNodeVariable,
                            parameterPrefix: `${parameterPrefix ? `${parameterPrefix}.` : `${nodeVariable}_`}${
                                resolveTree.name
                            }.edges.node`,
                        });
                        nestedSubqueries.push(nestedConnection[0]);

                        legacyProjectionWhereParams = {
                            ...legacyProjectionWhereParams,
                            ...Object.entries(nestedConnection[1]).reduce<Record<string, unknown>>((res, [k, v]) => {
                                if (k !== `${relatedNodeVariable}_${connectionResolveTree.name}`) {
                                    res[k] = v;
                                }
                                return res;
                            }, {}),
                        };

                        if (nestedConnection[1][`${relatedNodeVariable}_${connectionResolveTree.name}`]) {
                            if (!nestedConnectionFieldParams) nestedConnectionFieldParams = {};
                            nestedConnectionFieldParams = {
                                ...nestedConnectionFieldParams,
                                ...{
                                    [connectionResolveTree.name]:
                                        nestedConnection[1][`${relatedNodeVariable}_${connectionResolveTree.name}`],
                                },
                            };
                        }
                    });
                }
            }

            unionSubquery.push(`WITH ${nodeVariable}`);
            unionSubquery.push(`OPTIONAL MATCH (${nodeVariable})${inStr}${relTypeStr}${outStr}${nodeOutStr}`);

            if (whereInput) {
                const where = createConnectionWhereAndParams({
                    whereInput,
                    node: n,
                    nodeVariable: relatedNodeVariable,
                    relationship,
                    relationshipVariable,
                    context,
                    parameterPrefix: `${parameterPrefix ? `${parameterPrefix}.` : `${nodeVariable}_`}${
                        resolveTree.name
                    }.args.where`,
                });
                const [whereClause] = where;
                if (whereClause) {
                    unionSubquery.push(`WHERE ${whereClause}`);
                }
            }

            if (nestedSubqueries.length) {
                unionSubquery.push(nestedSubqueries.join("\n"));
            }

            unionSubquery.push(`WITH { ${unionSubqueryElementsToCollect.join(", ")} } AS edge`);
            unionSubquery.push("RETURN edge");

            unionSubqueries.push(unionSubquery.join("\n"));
        });

        subquery.push(["CALL {", unionSubqueries.join("\nUNION\n"), "}", "WITH collect(edge) as edges"].join("\n"));
    } else {
        const relatedNodeVariable = `${nodeVariable}_${field.relationship.typeMeta.name.toLowerCase()}`;
        const nodeOutStr = `(${relatedNodeVariable}:${field.relationship.typeMeta.name})`;
        const relatedNode = context.neoSchema.nodes.find((x) => x.name === field.relationship.typeMeta.name) as Node;

        /*
        MATCH clause, example:

        MATCH (this)<-[this_acted_in:ACTED_IN]-(this_actor:Actor)
        */
        subquery.push(`MATCH (${nodeVariable})${inStr}${relTypeStr}${outStr}${nodeOutStr}`);

        if (whereInput) {
            const where = createConnectionWhereAndParams({
                whereInput,
                node: relatedNode,
                nodeVariable: relatedNodeVariable,
                relationship,
                relationshipVariable,
                context,
                parameterPrefix: `${parameterPrefix ? `${parameterPrefix}.` : `${nodeVariable}_`}${
                    resolveTree.name
                }.args.where`,
            });
            const [whereClause] = where;
            subquery.push(`WHERE ${whereClause}`);
        }

        if (sortInput && sortInput.length) {
            const sort = sortInput.map((s) =>
                [
                    ...Object.entries(s.relationship || []).map(
                        ([f, direction]) => `${relationshipVariable}.${f} ${direction}`
                    ),
                    ...Object.entries(s.node || []).map(([f, direction]) => `${relatedNodeVariable}.${f} ${direction}`),
                ].join(", ")
            );
            subquery.push(`WITH ${relationshipVariable}, ${relatedNodeVariable}`);
            subquery.push(`ORDER BY ${sort.join(", ")}`);
        }

        const nestedSubqueries: string[] = [];

        if (node) {
            const nodeProjectionAndParams = createProjectionAndParams({
                fieldsByTypeName: node?.fieldsByTypeName,
                node: relatedNode,
                context,
                varName: relatedNodeVariable,
                literalElements: true,
            });
            const [nodeProjection, nodeProjectionParams] = nodeProjectionAndParams;
            elementsToCollect.push(`node: ${nodeProjection}`);
            legacyProjectionWhereParams = nodeProjectionParams;

            if (nodeProjectionAndParams[2]?.connectionFields?.length) {
                nodeProjectionAndParams[2].connectionFields.forEach((connectionResolveTree) => {
                    const connectionField = relatedNode.connectionFields.find(
                        (x) => x.fieldName === connectionResolveTree.name
                    ) as ConnectionField;
                    const nestedConnection = createConnectionAndParams({
                        resolveTree: connectionResolveTree,
                        field: connectionField,
                        context,
                        nodeVariable: relatedNodeVariable,
                        parameterPrefix: `${parameterPrefix ? `${parameterPrefix}.` : `${nodeVariable}_`}${
                            resolveTree.name
                        }.edges.node`,
                    });
                    nestedSubqueries.push(nestedConnection[0]);

                    legacyProjectionWhereParams = {
                        ...legacyProjectionWhereParams,
                        ...Object.entries(nestedConnection[1]).reduce<Record<string, unknown>>((res, [k, v]) => {
                            if (k !== `${relatedNodeVariable}_${connectionResolveTree.name}`) {
                                res[k] = v;
                            }
                            return res;
                        }, {}),
                    };

                    if (nestedConnection[1][`${relatedNodeVariable}_${connectionResolveTree.name}`]) {
                        if (!nestedConnectionFieldParams) nestedConnectionFieldParams = {};
                        nestedConnectionFieldParams = {
                            ...nestedConnectionFieldParams,
                            ...{
                                [connectionResolveTree.name]:
                                    nestedConnection[1][`${relatedNodeVariable}_${connectionResolveTree.name}`],
                            },
                        };
                    }
                });
            }
        }

        if (nestedSubqueries.length) subquery.push(nestedSubqueries.join("\n"));
        subquery.push(`WITH collect({ ${elementsToCollect.join(", ")} }) AS edges`);
    }

    subquery.push(`RETURN { edges: edges } AS ${resolveTree.alias}`);
    subquery.push("}");

    const params = {
        ...legacyProjectionWhereParams,
        ...((whereInput || nestedConnectionFieldParams) && {
            [`${nodeVariable}_${resolveTree.name}`]: {
                ...(whereInput && { args: { where: whereInput } }),
                ...(nestedConnectionFieldParams && { edges: { node: { ...nestedConnectionFieldParams } } }),
            },
        }),
    };

    return [subquery.join("\n"), params];
}

export default createConnectionAndParams;