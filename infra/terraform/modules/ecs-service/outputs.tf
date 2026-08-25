output "cluster_id" {
  description = "Identifiant du cluster ECS."
  value       = aws_ecs_cluster.this.id
}

output "cluster_name" {
  description = "Nom du cluster ECS."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ARN du cluster ECS."
  value       = aws_ecs_cluster.this.arn
}

output "alb_arn" {
  description = "ARN de l'Application Load Balancer."
  value       = aws_lb.this.arn
}

output "alb_arn_suffix" {
  description = "Suffixe d'ARN de l'ALB, tel que l'attendent les dimensions de métriques CloudWatch — c'est lui qui sert à poser les alarmes 5xx et latence p99."
  value       = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  description = "Nom DNS public de l'ALB — cible de l'alias Route 53."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Zone hébergée de l'ALB, requise par un enregistrement d'alias Route 53."
  value       = aws_lb.this.zone_id
}

output "alb_security_group_id" {
  description = "Groupe de sécurité de l'ALB."
  value       = aws_security_group.alb.id
}

output "https_listener_arn" {
  description = "Listener 443. À référencer pour ajouter une règle d'écoute hors de ce module."
  value       = aws_lb_listener.https.arn
}

output "tasks_security_group_id" {
  description = "Groupe de sécurité des tâches Fargate. C'est lui que les modules `database` et `cache` autorisent en entrée — jamais un bloc CIDR."
  value       = aws_security_group.tasks.id
}

output "service_names" {
  description = "Nom du service ECS, par clé de `services`."
  value       = { for name, service in aws_ecs_service.this : name => service.name }
}

output "service_arns" {
  description = "ARN du service ECS, par clé de `services`."
  value       = { for name, service in aws_ecs_service.this : name => service.id }
}

output "task_definition_arns" {
  description = "ARN de la définition de tâche courante, par clé de `services`."
  value       = { for name, definition in aws_ecs_task_definition.this : name => definition.arn }
}

output "task_role_arns" {
  description = "ARN du rôle applicatif, par clé de `services` — celui auquel une politique métier doit être accordée."
  value       = { for name, role in aws_iam_role.task : name => role.arn }
}

output "task_role_names" {
  description = "Nom du rôle applicatif, par clé de `services`."
  value       = { for name, role in aws_iam_role.task : name => role.name }
}

output "execution_role_arns" {
  description = "ARN du rôle d'exécution, par clé de `services`."
  value       = { for name, role in aws_iam_role.execution : name => role.arn }
}

output "target_group_arns" {
  description = "ARN du groupe cible, par clé de `services`."
  value       = { for name, group in aws_lb_target_group.service : name => group.arn }
}

output "target_group_arn_suffixes" {
  description = "Suffixe d'ARN du groupe cible, par clé de `services` — dimension des métriques CloudWatch par service."
  value       = { for name, group in aws_lb_target_group.service : name => group.arn_suffix }
}

output "log_group_names" {
  description = "Groupe de journaux CloudWatch, par clé de `services`."
  value       = { for name, group in aws_cloudwatch_log_group.service : name => group.name }
}
