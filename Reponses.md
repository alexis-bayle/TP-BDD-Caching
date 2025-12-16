## D4 - Réponses:
❓ Question : Pourquoi peut-on lire une ancienne valeur ?

- La réplication vers le réplica n'est pas instantanné (du à la latence) donc une lecture sur le réplica peut "voir" une donnée erronée.
- Le cache peut renvoyer une valeur erronée si TTL non-expiré ou si l'invalidation a échouée / pas eu lieu (redis down par ex)

## E2
- erreur explicite

## Questions finales
1. Réplication vs haute disponibilité

La réplication copie les données du primary -> replica pour améliorer la lecture, mais ne garantit pas que le service continue automatiquement si le primary tombe. La haute disponibilité vise à garder le service disponible malgré une panne, via une bascule (failover) vers un nouveau primary.

2. Qu’est-ce qui est manuel ici ? Automatique ?

Automatique: la réplication: le routage “écritures -> primary / lectures -> replica” tant que tout est OK. L’invalidation Redis au PUT (côté API).

Manuel: La promotion du replica en primary et la bascule HAProxy. le failover n’est pas automatique dans cette situation.

3. Risques cache + réplication

Données périmées: latence de réplication -> la replica peut renvoyer l’ancienne valeur juste après un update, et le cache peut amplifier ça.

Read-after-write incohérent: après un PUT, un GET peut relire sur la replica (pas encore update) et remettre en cache une ancienne valeur (même si invalidé juste avant)

Pannes partielles: si Redis est down et qu'il n'y a pas de switch vers le primary alors certaines routes deviennent indisponibles. Si l’invalidation échoue, ça peut renvoyer des valeurs obsolètes jusqu’au TTL.

4. Comment améliorer l’architecture en production ?

Mettre en place un failover automatique postgreSQL. Un health check -> promotion -> reroutage automatiques.

Un cache plus robuste: TTL plus court, gestion de pannes (fallback sans cache pour Redis down).
