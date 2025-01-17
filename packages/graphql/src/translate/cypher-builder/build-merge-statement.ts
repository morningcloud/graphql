/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Context, RelationField } from "../../types";
import { Node, Neo4jGraphQLCypherBuilderError } from "../../classes";
import { CypherStatement } from "../types";
import { joinStrings } from "../../utils/utils";
import { buildNodeStatement } from "./build-node-statement";
import { buildRelationshipStatement } from "./build-relationship-statement";
import { generateParameterKey } from "./utils";
import { joinStatements } from "./join-statements";

type NodeOptions = {
    varName: string;
    node?: Node;
    parameters?: Record<string, any>;
    onCreate?: Record<string, any>;
};

type TargetRelation = {
    varName?: string;
    relationField: RelationField;
    onCreate?: Record<string, any>;
};

type MergeNodeArguments = {
    sourceNode: NodeOptions & { node: Node };
    context: Context;
};

type MergeRelationArguments = {
    sourceNode: NodeOptions;
    targetNode: NodeOptions;
    relationship: TargetRelation;
    context: Context;
};

export function buildMergeStatement(args: MergeNodeArguments): CypherStatement;
export function buildMergeStatement(args: MergeRelationArguments): CypherStatement;
export function buildMergeStatement({
    sourceNode,
    targetNode,
    relationship,
    context,
}: {
    sourceNode: NodeOptions;
    targetNode?: NodeOptions;
    relationship?: TargetRelation;
    context: Context;
}): CypherStatement {
    const onCreateStatements: Array<CypherStatement> = [];
    let leftStatement: CypherStatement | undefined;
    let relationOnCreateStatement: CypherStatement | undefined;

    if (sourceNode.node) {
        // Autogenerate fields for left node
        sourceNode.node.primitiveFields
            // Filter for autogenerated fields (e.g. @id) but only if field is not included in where
            .filter(
                (field) => field.autogenerate && !Object.keys(sourceNode.parameters ?? []).includes(field.fieldName)
            )
            .forEach((field) => {
                onCreateStatements.push([`${sourceNode.varName}.${field.dbPropertyName} = randomUUID(),\n`, {}]);
            });

        sourceNode.node.temporalFields
            .filter(
                (field) => ["DateTime", "Time"].includes(field.typeMeta.name) && field.timestamps?.includes("CREATE")
            )
            .forEach((field) => {
                onCreateStatements.push([
                    `${sourceNode.varName}.${field.dbPropertyName} = ${field.typeMeta.name.toLowerCase()}(),\n`,
                    {},
                ]);
            });
    }

    if (sourceNode.onCreate) {
        onCreateStatements.push(buildOnCreate(sourceNode.onCreate, sourceNode.varName));
    }
    if (targetNode?.onCreate) {
        onCreateStatements.push(buildOnCreate(targetNode.onCreate, targetNode.varName));
    }

    if (relationship || targetNode) {
        if (!relationship) {
            throw new Neo4jGraphQLCypherBuilderError("Missing relationship in Cypher merge relationship statement");
        }
        if (!targetNode) {
            throw new Neo4jGraphQLCypherBuilderError("Missing rightnode in Cypher merge relationship statement");
        }

        const relationshipName = relationship.varName || `${sourceNode.varName}_relationship_${targetNode.varName}`;
        leftStatement = buildRelationshipStatement({
            context,
            sourceNode,
            targetNode,
            relationship: {
                relationField: relationship.relationField,
                varName: relationshipName,
            },
        });

        const relationshipFields = context.neoSchema.relationships.find(
            (x) => x.properties === relationship.relationField.properties
        );

        if (relationshipFields) {
            // Autogenerate fields for relationship
            relationshipFields.primitiveFields
                .filter((field) => field.autogenerate)
                .forEach((field) => {
                    onCreateStatements.push([`${relationshipName}.${field.dbPropertyName} = randomUUID(),\n`, {}]);
                });

            relationshipFields.temporalFields
                .filter(
                    (field) =>
                        ["DateTime", "Time"].includes(field.typeMeta.name) && field.timestamps?.includes("CREATE")
                )
                .forEach((field) => {
                    onCreateStatements.push([
                        `${relationshipName}.${field.dbPropertyName} = ${field.typeMeta.name.toLowerCase()}(),\n`,
                        {},
                    ]);
                });
        }

        if (relationship.onCreate) {
            relationOnCreateStatement = buildOnCreate(relationship.onCreate, relationshipName);
            onCreateStatements.push(relationOnCreateStatement);
        }
    } else {
        leftStatement = buildNodeStatement({
            ...sourceNode,
            context,
        });
    }

    const mergeNodeStatement = joinStatements(["MERGE ", leftStatement], "");

    const onCreateSetQuery = onCreateStatements.length > 0 ? "ON CREATE\nSET" : "";
    return joinStatements([mergeNodeStatement, onCreateSetQuery, ...onCreateStatements]);
}

function buildOnCreate(onCreate: Record<string, any>, varName: string): CypherStatement {
    const queries: string[] = [];
    const parameters = {};

    Object.entries(onCreate).forEach(([key, value]) => {
        queries.push(`${varName}.${key} = $${generateParameterKey(`${varName}_on_create`, key)}`);
        parameters[generateParameterKey(`${varName}_on_create`, key)] = value;
    });
    return [joinStrings(queries, ",\n"), parameters];
}
