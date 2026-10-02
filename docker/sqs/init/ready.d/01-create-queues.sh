#!/bin/bash
set -euo pipefail

dlq_url=$(awslocal sqs create-queue \
  --queue-name "$SQS_WAGER_DLQ_NAME" \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)

dlq_arn=$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

redrive_policy="{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${SQS_MAX_RECEIVE_COUNT}\\\"}"

awslocal sqs create-queue \
  --queue-name "$SQS_WAGER_QUEUE_NAME" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"ReceiveMessageWaitTimeSeconds\":\"20\",\"RedrivePolicy\":\"${redrive_policy}\"}" \
  --query QueueUrl --output text

awslocal sqs create-queue \
  --queue-name "$SQS_EVENTS_QUEUE_NAME" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text
