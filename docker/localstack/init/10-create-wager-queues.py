"""Esta página cria as filas FIFO e a fila de mensagens não processadas no LocalStack.
Assinatura: Leonardo de Souza da Luz
"""
import json
import os

import boto3


region = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
sqs = boto3.client(
    "sqs",
    endpoint_url="http://localhost:4566",
    region_name=region,
    aws_access_key_id="test",
    aws_secret_access_key="test",
)

dead_letter_queue_name = "wager-transactions-dlq.fifo"
queue_name = "wager-transactions.fifo"

dead_letter_queue_url = sqs.create_queue(
    QueueName=dead_letter_queue_name,
    Attributes={
        "FifoQueue": "true",
        "ContentBasedDeduplication": "true",
    },
)["QueueUrl"]

dead_letter_queue_arn = sqs.get_queue_attributes(
    QueueUrl=dead_letter_queue_url,
    AttributeNames=["QueueArn"],
)["Attributes"]["QueueArn"]

sqs.create_queue(
    QueueName=queue_name,
    Attributes={
        "FifoQueue": "true",
        "ContentBasedDeduplication": "true",
        "RedrivePolicy": json.dumps(
            {
                "deadLetterTargetArn": dead_letter_queue_arn,
                "maxReceiveCount": "5",
            }
        ),
    },
)
