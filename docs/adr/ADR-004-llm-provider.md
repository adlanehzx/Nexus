# ADR-004 — Abstraction `LLMProvider`

**Statut** : Proposé · 2026-09-01

## Contexte

Le paysage des modèles change tous les trimestres : prix, capacités, formats de tool-calling,
disponibilité. Le cahier des charges impose que les providers soient interchangeables et que
« le reste de l'application ne dépende jamais directement d'un SDK LLM ».

## Décision

Un port unique dans `@nexus/llm` :

```ts
interface LLMProvider {
  readonly id: string;
  readonly capabilities: { tools: boolean; vision: boolean; json: boolean; maxContext: number };
  generate(req: GenerateRequest): Promise<GenerateResponse>;
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>; // text | tool_call | usage | done
  structuredOutput<T>(req, schema: ZodType<T>): Promise<T>;
  countTokens(input: TokenCountInput): Promise<number>;
}
```

Les SDK vendeurs ne sont importés **que** dans `packages/llm/src/adapters/*`. Une règle de lint
interdit `@anthropic-ai/*`, `openai`, etc. ailleurs dans le dépôt. Les messages et les appels
d'outils circulent dans un format neutre (`@nexus/contracts`) ; chaque adaptateur traduit dans les
deux sens.

Un `LLMRouter` au-dessus choisit le modèle par tâche (planification, réponse, résumé de
compaction, classification), applique le fallback en cascade et le budget.

## Alternatives

- **Vercel AI SDK / LangChain.** Abstraction déjà faite — mais on hérite de leur modèle de données
  et de leurs ruptures ; LangChain impose en outre une conception d'agent dont nous ne voulons pas
  (notre boucle est explicite et persistée, cf. ADR-003). Une interface de 4 méthodes que nous
  possédons est plus petite que la surface d'API que nous éviterions.
- **Appel direct d'un SDK.** Rapide au départ, coûteux au premier changement, et incompatible avec
  l'exigence explicite du cahier des charges.

## Conséquences

**Positives** — changer de modèle est une ligne de configuration ; le fallback multi-provider est
possible en cas de panne ; `FakeLLM` scripté rend `agent-core` testable sans réseau ; le comptage
de tokens et de coûts est centralisé.

**Négatives, acceptées** — l'abstraction est le plus petit dénominateur commun : une nouveauté
propre à un fournisseur (cache de prompt, exécution serveur d'outils, mode « thinking ») demande
d'étendre `capabilities` plutôt que d'être utilisée directement. C'est un coût réel, assumé, et
mitigé par un mécanisme d'options `providerOptions` typées par adaptateur et jamais lues par
`agent-core`.
