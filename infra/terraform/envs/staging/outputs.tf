output "vpc_id" {
  description = "Identifiant du VPC de l'environnement."
  value       = module.network.vpc_id
}

output "vpc_cidr_block" {
  description = "Bloc CIDR du VPC."
  value       = module.network.vpc_cidr_block
}

output "public_subnet_ids" {
  description = "Sous-réseaux publics — ALB et NAT Gateway."
  value       = module.network.public_subnet_ids
}

output "app_subnet_ids" {
  description = "Sous-réseaux privés applicatifs — ECS Fargate et Lambda dans le VPC."
  value       = module.network.app_subnet_ids
}

output "data_subnet_ids" {
  description = "Sous-réseaux privés de données — RDS et ElastiCache, sans route vers Internet."
  value       = module.network.data_subnet_ids
}

output "data_route_table_id" {
  description = "Table de routage du niveau données. Elle ne doit jamais porter de route sortante."
  value       = module.network.data_route_table_id
}

output "nat_gateway_public_ips" {
  description = "Adresses publiques de sortie du VPC."
  value       = module.network.nat_gateway_public_ips
}

output "vpc_endpoint_security_group_id" {
  description = "Groupe de sécurité des endpoints d'interface."
  value       = module.network.vpc_endpoint_security_group_id
}
