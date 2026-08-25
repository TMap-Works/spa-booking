# Les listes de sous-réseaux sont ordonnées sur `local.availability_zones` et non
# sur l'ordre de parcours d'une map : un module consommateur qui indexe par rang
# — un groupe de sous-réseaux RDS, une définition de service ECS — doit obtenir
# deux fois la même réponse.

output "vpc_id" {
  description = "Identifiant du VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "Bloc CIDR du VPC, à référencer plutôt qu'à recopier."
  value       = aws_vpc.this.cidr_block
}

output "availability_zones" {
  description = "Zones de disponibilité couvertes, dans l'ordre qui sert d'index aux listes de sous-réseaux."
  value       = local.availability_zones
}

output "public_subnet_ids" {
  description = "Sous-réseaux publics — ALB et NAT Gateway."
  value       = [for az in local.availability_zones : aws_subnet.public[az].id]
}

output "app_subnet_ids" {
  description = "Sous-réseaux privés applicatifs — tâches ECS Fargate et Lambda dans le VPC."
  value       = [for az in local.availability_zones : aws_subnet.app[az].id]
}

output "data_subnet_ids" {
  description = "Sous-réseaux privés de données — RDS et ElastiCache. Aucune route vers Internet."
  value       = [for az in local.availability_zones : aws_subnet.data[az].id]
}

output "public_route_table_id" {
  description = "Table de routage du niveau public."
  value       = aws_route_table.public.id
}

output "app_route_table_ids" {
  description = "Tables de routage du niveau applicatif, une par zone, dans l'ordre de `availability_zones`."
  value       = [for az in local.availability_zones : aws_route_table.app[az].id]
}

output "data_route_table_id" {
  description = "Table de routage du niveau données. Elle ne porte aucune route sortante — c'est ce qui doit rester vrai à chaque plan."
  value       = aws_route_table.data.id
}

output "nat_gateway_ids" {
  description = "Identifiants des NAT Gateway déployées."
  value       = aws_nat_gateway.this[*].id
}

output "nat_gateway_public_ips" {
  description = "Adresses publiques de sortie du VPC — celles qu'un tiers doit inscrire sur liste d'autorisation."
  value       = aws_eip.nat[*].public_ip
}

output "vpc_endpoint_security_group_id" {
  description = "Groupe de sécurité des endpoints d'interface."
  value       = aws_security_group.vpc_endpoints.id
}

output "s3_vpc_endpoint_id" {
  description = "Endpoint de passerelle S3, associé aux tables de routage privées."
  value       = aws_vpc_endpoint.s3.id
}

output "interface_vpc_endpoint_ids" {
  description = "Endpoints d'interface, par nom de service abrégé."
  value       = { for service, endpoint in aws_vpc_endpoint.interface : service => endpoint.id }
}
